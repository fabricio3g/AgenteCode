// ── Code section on the Rust runtime ───────────────────────────────────
// Every Code chat runs on the Rust runtime (`agente serve`): each chat is a
// runtime session, Desktop's providers are handed over with
// runtime.configure, and the runtime's events are translated back into the
// CodeAgentEvent stream the UI renders.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { resolveApiKey } from '../provider-auth.ts';
import { getAppPaths } from '../paths.ts';
import { loadConfig, saveConfig } from '../config.ts';
import { getLlamaStatus, getPendingMainLaunch, getRecommendedSettings, startLlama } from '../llm-runner.ts';
import { moduleDirname } from '../module-env.ts';
import { AgenteDaemon, resolveAgenteBinary } from '../agente-daemon.ts';
import type { AgenteClient } from '../agente-client.ts';
import { emitCodeAgentEvent, getCodeMainWindow } from './event-bridge.ts';
import { createProviderPreflight, RuntimeNoModelError } from './provider-preflight.ts';
import { resolveContextWindow, resolveTransport, transportSeesImages } from './transport.ts';
import { createBrowserTools } from './tools/browser.ts';
import { serveDesktopTools, type DesktopToolServer } from './desktop-tools-mcp.ts';
import { RustProcessBridge } from './rust-processes.ts';
import { RustTurnTranslator } from './rust-events.ts';
import type { AgenteCheckpointSummary, AgenteRuntimeMode, AgenteStartSessionArgs, ApprovalDecision, CodeAgentEvent } from '../../shared/agente-protocol.ts';
import type { Attachment, Message, RuntimeEventEnvelope, SessionSnapshot, TurnMode, TurnOutcome } from '../../shared/agente-protocol.gen.ts';

const FALLBACK_CONTEXT_WINDOW = 32_768;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ChatState = {
  chatId: string;
  sessionId: string;
  projectRoot: string;
  provider: string;
  model: string;
  thinkingLevel?: string;
  mode: AgenteRuntimeMode;
  /** Sent with the first turn of a new session only. */
  systemPrompt?: string;
  turnId: string | null;
  followUps: Array<{ text: string; attachments: Attachment[] }>;
  contextWindow: number;
  translator: RustTurnTranslator;
  checkpoints: AgenteCheckpointSummary[];
};

const chats = new Map<string, ChatState>();
let daemon: AgenteDaemon | null = null;
let listening: AgenteClient | null = null;
let desktopTools: Promise<DesktopToolServer> | null = null;
let connectionPromise: Promise<AgenteClient> | null = null;

const ensureProvider = createProviderPreflight({
  localConfig: () => (loadConfig().llm?.local ?? {}) as Record<string, unknown>,
  status: getLlamaStatus,
  pendingLaunch: getPendingMainLaunch,
  recommended: getRecommendedSettings,
  start: (config) => startLlama(config, getCodeMainWindow()),
  locale: desktopLocale
});

function desktopLocale(): string {
  return app?.getLocale?.() || 'en';
}

/** Dev servers the runtime runs for Rust-engine chats, for the Processes pane. */
export const rustProcesses = new RustProcessBridge(
  () => (daemon ? connect() : null),
  () => [...chats.values()].map((chat) => ({ chatId: chat.chatId, projectRoot: chat.projectRoot }))
);
/** The chat that sent the latest message: whose model screenshots are for. */
let activeChat: ChatState | null = null;

/**
 * Serve Desktop-only tools (the in-app browser) to the runtime as the MCP
 * server `desktop`: they show up in the loop as desktop_browser_open, …
 */
async function registerDesktopTools(client: AgenteClient): Promise<void> {
  desktopTools ??= serveDesktopTools(
    createBrowserTools({
      canSeeImages: () => !!activeChat && transportSeesImages(resolveTransport(activeChat.provider, activeChat.model))
    })
  );
  const server = await desktopTools;
  await client.request('runtime.configure', {
    mcp: { desktop: { type: 'http', url: server.url, headers: { Authorization: `Bearer ${server.token}` } } }
  });
}

/** The monorepo root, found upward from this module (development builds). */
function findRepoRoot(start: string): string | undefined {
  let dir = start;
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'Cargo.toml')) && fs.existsSync(path.join(dir, 'crates'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function connect(): Promise<AgenteClient> {
  if (!connectionPromise) {
    const connecting = openConnection();
    connectionPromise = connecting;
    void connecting.catch(() => { if (connectionPromise === connecting) connectionPromise = null; });
  }
  return connectionPromise;
}

async function openConnection(): Promise<AgenteClient> {
  if (!daemon) {
    const binary = resolveAgenteBinary({
      resourcesPath: typeof process.resourcesPath === 'string' ? process.resourcesPath : undefined,
      repoRoot: findRepoRoot(moduleDirname(import.meta.url))
    });
    daemon = new AgenteDaemon({ binary });
  }
  const client = await daemon.connect();
  if (listening !== client) {
    listening = client;
    client.onClose(() => {
      if (listening !== client) return;
      listening = null;
      connectionPromise = null;
      for (const chat of chats.values()) {
        if (!chat.turnId) continue;
        chat.turnId = null;
        chat.followUps = [];
        emit({ type: 'error', chatId: chat.chatId, message: 'The Rust runtime disconnected. Reconnect by sending a new message.' });
        emit({ type: 'agent_end', chatId: chat.chatId, stopReason: 'error' });
      }
    });
    client.onNotification((method, params) => {
      if (method === 'turn.outcome') {
        const outcome = params as TurnOutcome;
        const chat = [...chats.values()].find((state) => state.sessionId === outcome.session_id);
        if (chat && (!chat.turnId || chat.turnId === outcome.turn_id)) continueWithFollowUp(chat);
        return;
      }
      if (method !== 'event') return;
      const envelope = params as RuntimeEventEnvelope;
      route(envelope);
      for (const listener of runtimeEventListeners) listener(envelope);
    });
    // Turns this app didn't start (bot routines, handoffs) arrive this way;
    // the runtime never sends a turn twice to the client that started it.
    await client.request('events.subscribe', {}).catch(() => {});
    await registerDesktopTools(client).catch((error: unknown) => {
      console.warn(`[agente] desktop tools unavailable: ${error instanceof Error ? error.message : String(error)}`);
    });
    const saved = loadConfig().agent_runtime as Record<string, unknown> | undefined;
    if (saved) {
      const overrides = saved.subagent_models as Record<string, { provider: string; model: string }> | undefined;
      for (const model of Object.values(overrides || {})) {
        if (model.provider.startsWith('desktop-')) await useProvider(client, model.provider.slice(8), model.model);
      }
      await client.request('runtime.configure', saved);
    }
  }
  return client;
}

/**
 * Hand the runtime Desktop's provider (with its key, over the socket only)
 * and return the id and model a turn should name.
 */
export async function useProvider(client: AgenteClient, providerName: string, model: string): Promise<{ id: string; model: string }> {
  const resolved = resolveTransport(providerName, model);
  await ensureProvider(resolved);
  if (resolved.providerName === 'local' && !resolved.model) model = String(getLlamaStatus().model_id || '');
  const provider = providerEntry(providerName, model);
  if (!provider.model) throw new RuntimeNoModelError(desktopLocale());
  const transport = resolveTransport(providerName, model);
  const info = await client.request<{ capabilities: Record<string, unknown>; cost: unknown; limits: unknown; reasoning_options?: unknown; reasoning_stream_field?: string }>('models.info', { provider: transport.providerName, model: provider.model });
  const capabilities = providerCapabilities(transport, info.capabilities);
  provider.config.models = { [provider.model]: { name: provider.model, capabilities, cost: info.cost, limit: info.limits, reasoning_options: info.reasoning_options, reasoning_stream_field: info.reasoning_stream_field } };
  await client.request('runtime.configure', { provider: { [provider.id]: provider.config } });
  return { id: provider.id, model: provider.model };
}

function providerCapabilities(transport: ReturnType<typeof resolveTransport>, source: Record<string, unknown>): Record<string, unknown> {
  const capabilities = { ...source };
  if (transport.providerName !== 'local') return capabilities;
  const modalities = getLlamaStatus().modalities;
  capabilities.vision = transportSeesImages(transport);
  capabilities.input_modalities = Array.isArray(modalities) ? modalities : capabilities.vision ? ['text', 'image'] : ['text'];
  return capabilities;
}

type RuntimeEventListener = (envelope: RuntimeEventEnvelope) => void;
const runtimeEventListeners = new Set<RuntimeEventListener>();

/** Every runtime event, from any session (bots use it; Code chats route their own). */
export function onRuntimeEvent(listener: RuntimeEventListener): () => void {
  runtimeEventListeners.add(listener);
  return () => runtimeEventListeners.delete(listener);
}

/** The runtime connection, started on first use. */
export function runtimeConnection(): Promise<AgenteClient> {
  return connect();
}

function emit(event: CodeAgentEvent): void {
  emitCodeAgentEvent(null, event);
}

function recordCheckpoint(chat: ChatState, event: Extract<CodeAgentEvent, { type: 'checkpoint_finalized' }>): void {
  chat.checkpoints.push({
    turnIndex: event.turnIndex,
    createdAt: Date.now(),
    fileCount: event.files.length,
    additions: event.files.reduce((sum, file) => sum + file.additions, 0),
    deletions: event.files.reduce((sum, file) => sum + file.deletions, 0),
    files: event.files.map((file) => file.path)
  });
}

/** The turn ended: send the next queued follow-up, if any. */
function continueWithFollowUp(chat: ChatState): void {
  chat.turnId = null;
  const next = chat.followUps.shift();
  if (next !== undefined) void prompt(chat.chatId, next.text, undefined, next.attachments);
}

function route(envelope: RuntimeEventEnvelope): void {
  const chat = [...chats.values()].find((state) => state.sessionId === envelope.session_id);
  if (!chat) return;
  if (envelope.event.type === 'turn_started' && !envelope.parent_run_id) chat.turnId = envelope.turn_id;
  for (const event of chat.translator.translate(envelope)) {
    if (event.type === 'checkpoint_finalized') recordCheckpoint(chat, event);
    emit(event);
    // A command may have left a server running in the background.
    if (event.type === 'tool_end') rustProcesses.nudge();
  }
}

const TURN_MODES: Record<AgenteRuntimeMode, TurnMode> = { full: 'auto', supervised: 'build', plan: 'plan' };

/** Desktop's provider and model, as a provider entry for runtime.configure. */
function providerEntry(providerName: string, model: string): { id: string; config: Record<string, unknown>; model: string } {
  const transport = resolveTransport(providerName, model);
  return {
    id: `desktop-${transport.providerName}`,
    model: transport.model,
    config: providerConfig(providerName, [transport.model])
  };
}

/** A provider as the runtime takes it: Desktop's endpoint and key, and these models. */
export function providerConfig(providerName: string, models: string[]): Record<string, unknown> {
  const transport = resolveTransport(providerName, models[0]);
  const apiKey = resolveApiKey('', transport.baseUrl, transport.providerName) || undefined;
  return {
    name: transport.providerName,
    api_format: 'openai',
    options: { baseURL: transport.baseUrl, ...(apiKey ? { apiKey } : {}) },
    models: Object.fromEntries(models.map((model) => [model, { name: model }]))
  };
}

/** Pasted images become stored files the runtime can attach. */
function storeImages(images: Array<{ data: string; mimeType: string }> | undefined): Attachment[] {
  if (!images?.length) return [];
  const dir = path.join(getAppPaths().appData, 'agente', 'attachments');
  fs.mkdirSync(dir, { recursive: true });
  return images.map((image, index) => {
    const extension = image.mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png';
    const name = `image-${index + 1}.${extension}`;
    const file = path.join(dir, `${crypto.randomUUID()}.${extension}`);
    const bytes = Buffer.from(image.data.replace(/^data:[^,]*,/, ''), 'base64');
    fs.writeFileSync(file, bytes);
    return { kind: 'image', mime: image.mimeType, name, path: file, bytes: bytes.length };
  });
}

function refreshContextWindow(chat: ChatState): void {
  void resolveContextWindow(resolveTransport(chat.provider, chat.model))
    .then((window) => {
      chat.contextWindow = window;
    })
    .catch(() => {});
}

/** turn.start parameters for a chat's next message. */
function turnParams(chat: ChatState, provider: { id: string; model: string }, message: Message): Record<string, unknown> {
  return {
    session_id: chat.sessionId,
    prompt: message,
    provider: provider.id,
    model: provider.model,
    thinking_level: chat.thinkingLevel ?? null,
    mode: TURN_MODES[chat.mode],
    project_dir: chat.projectRoot,
    origin: { channel: 'desktop', trust: 'owner' },
    ...(chat.systemPrompt ? { system_prompt: chat.systemPrompt } : {})
  };
}

async function startSession(args: AgenteStartSessionArgs): Promise<{ sessionId: string; resumed: boolean; conversationIndex: number }> {
  await ensureProvider(resolveTransport(args.provider, args.model));
  const live = chats.get(args.chatId);
  if (live) {
    Object.assign(live, { provider: args.provider, model: args.model, mode: args.runtimeMode, thinkingLevel: args.thinkingLevel });
    const current = await runtimeRequest<{ snapshot: SessionSnapshot }>('session.get', { session_id: live.sessionId });
    return { sessionId: live.sessionId, resumed: true, conversationIndex: current.snapshot.conversation.length };
  }
  const client = await connect();
  const sessionId = args.resumeSessionId && UUID.test(args.resumeSessionId) ? args.resumeSessionId : crypto.randomUUID();
  const existing = await client.request<{ snapshot: SessionSnapshot }>('session.open', { session_id: sessionId, project_dir: args.projectRoot });
  const resumed = existing.snapshot.conversation.length > 0;
  const chat: ChatState = {
    chatId: args.chatId,
    sessionId,
    projectRoot: args.projectRoot,
    provider: args.provider,
    model: args.model,
    thinkingLevel: args.thinkingLevel,
    mode: args.runtimeMode,
    systemPrompt: resumed ? undefined : args.systemPromptOverride,
    turnId: null,
    followUps: [],
    contextWindow: FALLBACK_CONTEXT_WINDOW,
    translator: undefined as unknown as RustTurnTranslator,
    checkpoints: []
  };
  chat.translator = new RustTurnTranslator(args.chatId, () => chat.contextWindow);
  chats.set(args.chatId, chat);
  refreshContextWindow(chat);
  return { sessionId, resumed, conversationIndex: existing.snapshot.conversation.length };
}

async function prompt(chatId: string, text: string, images?: Array<{ data: string; mimeType: string }>, attachments: Attachment[] = []): Promise<{ ok: boolean; error?: string; errorKey?: string; conversationIndex?: number }> {
  const chat = chats.get(chatId);
  if (!chat) return { ok: false, error: 'No active agente session for this chat' };
  try {
    await ensureProvider(resolveTransport(chat.provider, chat.model));
    const client = await connect();
    activeChat = chat;
    const provider = await useProvider(client, chat.provider, chat.model);
    const expanded = await client.request<{ text: string }>('project.expand_prompt', { project_dir: chat.projectRoot, text });
    const media = [...attachments, ...storeImages(images)];
    if (media.length) {
      const info = await client.request<{ capabilities: { input_modalities?: string[]; vision: boolean } }>('models.info', { provider: provider.id, model: provider.model });
      const modalities = info.capabilities.input_modalities || [];
      const unsupported = media.filter((item) => modalities.length ? !modalities.includes(item.kind) && !(item.kind === 'pdf' && modalities.includes('file')) : item.kind !== 'image' || !info.capabilities.vision);
      if (unsupported.length) throw new Error(`The selected model cannot accept ${unsupported.map((item) => item.name).join(', ')}. Choose a model with those input modalities.`);
    }
    const message: Message = { role: 'user', content: expanded.text, attachments: media };
    const started = await client.request<{ turn_id: string; conversation_index?: number }>('turn.start', turnParams(chat, provider, message));
    chat.systemPrompt = undefined;
    chat.turnId = started.turn_id;
    return { ok: true, conversationIndex: started.conversation_index };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: 'error', chatId, message });
    return failedPrompt(error, message);
  }
}

function failedPrompt(error: unknown, message: string): { ok: false; error: string; errorKey?: string } {
  return { ok: false, error: message, ...(error instanceof RuntimeNoModelError ? { errorKey: error.errorKey } : {}) };
}

async function steer(chatId: string, text: string, attachments: Attachment[] = []): Promise<{ ok: boolean }> {
  const chat = chats.get(chatId);
  if (!chat) return { ok: false };
  if (!chat.turnId) return queueFollowUp(chat, text, attachments);
  const client = await connect();
  const expanded = await client.request<{ text: string }>('project.expand_prompt', { project_dir: chat.projectRoot, text });
  return client.request('turn.steer', { turn_id: chat.turnId, content: expanded.text, attachments });
}

async function followUp(chatId: string, text: string, attachments: Attachment[] = []): Promise<{ ok: boolean }> {
  const chat = chats.get(chatId);
  return chat ? queueFollowUp(chat, text, attachments) : { ok: false };
}

async function queueFollowUp(chat: ChatState, text: string, attachments: Attachment[]): Promise<{ ok: boolean }> {
  if (!chat.turnId) return prompt(chat.chatId, text, undefined, attachments);
  chat.followUps.push({ text, attachments });
  return { ok: true };
}

async function abort(chatId: string): Promise<{ ok: boolean }> {
  const chat = chats.get(chatId);
  if (!chat?.turnId) return { ok: false };
  chat.followUps = [];
  const client = await connect();
  return client.request('turn.cancel', { turn_id: chat.turnId });
}

async function respondApproval(chatId: string, requestId: string, decision: ApprovalDecision): Promise<{ ok: boolean }> {
  if (!chats.has(chatId)) return { ok: false };
  const client = await connect();
  const result = await client.request<{ ok: boolean }>('approval.respond', { request_id: requestId, decision: decision === 'allow' ? 'approve_once' : 'deny' });
  if (result.ok) emit({ type: 'approval_resolved', chatId, requestId, decision });
  return result;
}

function setRuntimeMode(chatId: string, mode: AgenteRuntimeMode): { ok: boolean } {
  const chat = chats.get(chatId);
  if (!chat) return { ok: false };
  chat.mode = mode;
  return { ok: true };
}

function setModel(chatId: string, provider: string, model: string, thinkingLevel?: string): { ok: boolean } {
  const chat = chats.get(chatId);
  if (!chat) return { ok: false };
  Object.assign(chat, { provider, model, thinkingLevel });
  refreshContextWindow(chat);
  return { ok: true };
}

async function compact(chatId: string): Promise<{ ok: boolean; error?: string }> {
  const chat = chats.get(chatId);
  if (!chat) return { ok: false, error: 'No active session' };
  emit({ type: 'compaction_start', chatId, reason: 'manual' });
  try {
    const client = await connect();
    await client.request('session.compact', { session_id: chat.sessionId });
    emit({ type: 'compaction_end', chatId, reason: 'manual', success: true });
    return { ok: true };
  } catch (error: unknown) {
    emit({ type: 'compaction_end', chatId, reason: 'manual', success: false });
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** `!command` in the composer: run it in the project's shell, outside the model (owner only). */
async function exec(chatId: string, command: string): Promise<{ ok: boolean; error?: string }> {
  const chat = chats.get(chatId);
  if (!chat) return { ok: false, error: 'No active agente session for this chat' };
  try {
    const client = await connect();
    const started = await client.request<{ turn_id: string }>('turn.exec', {
      session_id: chat.sessionId,
      tool: 'shell',
      arguments: { command }
    });
    chat.turnId = started.turn_id;
    return { ok: true };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Undo or redo the last batch of file edits in the chat's session. */
async function edits(chatId: string, action: 'undo' | 'redo'): Promise<{ ok: boolean; files?: string[]; error?: string }> {
  const chat = chats.get(chatId);
  if (!chat) return { ok: false, error: 'No active session' };
  try {
    const client = await connect();
    const result = await client.request<{ paths: string[] }>(`edits.${action}`, { session_id: chat.sessionId });
    return { ok: true, files: result.paths };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Project and runtime lookups that need no chat: skills, subagents, commands, MCP, /init. */
async function runtimeRequest<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const client = await connect();
  return client.request<T>(method, params);
}

async function subagentModel(chatId: string, kind: string, inherit: boolean): Promise<{ ok: boolean }> {
  const chat = chats.get(chatId);
  if (!chat) throw new Error('Start a Code session before choosing subagent models.');
  const client = await connect();
  const settings = await client.request<{ subagent_models: Record<string, { provider: string; model: string }> }>('runtime.settings');
  const models = { ...settings.subagent_models };
  if (inherit) delete models[kind];
  else {
    const provider = await useProvider(client, chat.provider, chat.model);
    models[kind] = { provider: provider.id, model: provider.model };
  }
  return configureSettings({ subagent_models: models });
}

/** Persist only user settings; endpoint keys and Desktop's MCP token stay live. */
async function configureSettings(patch: Record<string, unknown>): Promise<{ ok: boolean }> {
  const allowed = ['smart_compaction', 'max_parallel_subagents', 'subagent_models', 'allow_media', 'approved_mcp_servers'];
  if (Object.keys(patch).some((key) => !allowed.includes(key))) throw new Error('Unknown agent setting.');
  if ('max_parallel_subagents' in patch && (!Number.isInteger(patch.max_parallel_subagents) || Number(patch.max_parallel_subagents) < 1 || Number(patch.max_parallel_subagents) > 32)) throw new Error('Choose 1–32 parallel subagents.');
  const result = await runtimeRequest<{ ok: boolean }>('runtime.configure', patch);
  const config = loadConfig();
  config.agent_runtime = { ...(config.agent_runtime as Record<string, unknown> || {}), ...patch };
  saveConfig(config);
  return result;
}

async function listCheckpoints(chatId: string, sessionId?: string): Promise<AgenteCheckpointSummary[]> {
  const id = chats.get(chatId)?.sessionId ?? sessionId;
  return id ? runtimeRequest('session.checkpoints', { session_id: id }) : [];
}

/**
 * Put the files back to how they were before `turnIndex`: undo the edits of
 * that turn and every later one, newest first. The conversation is kept.
 */
async function rollback(chatId: string, turnIndex: number, options: { sessionId?: string; projectRoot?: string } = {}): Promise<{ ok: boolean; restored?: number; files?: string[]; error?: string }> {
  const chat = chats.get(chatId);
  const sessionId = chat?.sessionId ?? options.sessionId;
  if (!sessionId) return { ok: false, error: 'No checkpoints for this conversation' };
  const later = (await listCheckpoints(chatId, sessionId)).filter((checkpoint) => checkpoint.turnIndex >= turnIndex);
  try {
    const client = await connect();
    const files = new Set<string>();
    for (let i = 0; i < later.length; i += 1) {
      const undone = await client.request<{ paths: string[] }>('edits.undo', { session_id: sessionId });
      for (const file of undone.paths) files.add(file);
    }
    if (chat) chat.checkpoints = chat.checkpoints.filter((checkpoint) => checkpoint.turnIndex < turnIndex);
    return { ok: true, restored: files.size, files: [...files] };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function messageAction(chatId: string, action: 'fork' | 'rewind', conversationIndex: number): Promise<{ sessionId: string; reverted?: number }> {
  const chat = chats.get(chatId);
  if (!chat) throw new Error('Open this conversation before using its message actions.');
  if (action === 'fork') {
    const snapshot = await runtimeRequest<SessionSnapshot>('session.fork', { session_id: chat.sessionId, conversation_index: conversationIndex });
    return { sessionId: snapshot.session_id };
  }
  const result = await runtimeRequest<{ reverted: number }>('edits.rewind', { session_id: chat.sessionId, conversation_index: conversationIndex });
  return { sessionId: chat.sessionId, reverted: result.reverted };
}

function liveChatIds(): string[] {
  return [...chats.values()].filter((chat) => !!chat.turnId).map((chat) => chat.chatId);
}

/** Runtime session ids named directly or by their live chats (which are forgotten). */
function sessionIdsToDelete(args: { chatIds?: string[]; sessionIds?: string[] }): string[] {
  const ids = new Set(args.sessionIds ?? []);
  for (const chatId of args.chatIds ?? []) {
    const chat = chats.get(chatId);
    if (chat) ids.add(chat.sessionId);
    chats.delete(chatId);
  }
  return [...ids].filter((id) => UUID.test(id));
}

async function deleteSessionData(args: { chatIds?: string[]; sessionIds?: string[] }): Promise<{ ok: boolean; removed: number }> {
  const ids = sessionIdsToDelete(args);
  if (!ids.length) return { ok: true, removed: 0 };
  const client = await connect();
  const results = await Promise.all(
    ids.map((id) => client.request<{ deleted: boolean }>('session.delete', { session_id: id }).catch(() => ({ deleted: false })))
  );
  return { ok: true, removed: results.filter((result) => result.deleted).length };
}

function disposeAllSessions(): void {
  chats.clear();
  daemon?.stop();
  daemon = null;
  listening = null;
  connectionPromise = null;
  activeChat = null;
  rustProcesses.dispose();
  void desktopTools?.then((server) => server.close());
  desktopTools = null;
}

/** The engine behind every Code chat. */
export const rustEngine = {
  startSession,
  prompt,
  steer,
  followUp,
  abort,
  respondApproval,
  setRuntimeMode,
  setModel,
  compact,
  exec,
  edits,
  runtimeRequest,
  messageAction,
  subagentModel,
  configureSettings,
  listCheckpoints,
  rollback,
  liveChatIds,
  deleteSessionData,
  disposeAllSessions
};

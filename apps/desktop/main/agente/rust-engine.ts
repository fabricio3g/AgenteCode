// ── Code section on the Rust runtime ───────────────────────────────────
// Every Code chat runs on the Rust runtime (`agente serve`): each chat is a
// runtime session, Desktop's providers are handed over with
// runtime.configure, and the runtime's events are translated back into the
// CodeAgentEvent stream the UI renders.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveApiKey } from '../chat-ipc.ts';
import { getAppPaths } from '../paths.ts';
import { moduleDirname } from '../module-env.ts';
import { AgenteDaemon, resolveAgenteBinary } from '../agente-daemon.ts';
import type { AgenteClient } from '../agente-client.ts';
import { emitCodeAgentEvent } from './event-bridge.ts';
import { resolveContextWindow, resolveTransport, transportSeesImages } from './transport.ts';
import { createBrowserTools } from './tools/browser.ts';
import { serveDesktopTools, type DesktopToolServer } from './desktop-tools-mcp.ts';
import { RustProcessBridge } from './rust-processes.ts';
import { RustTurnTranslator } from './rust-events.ts';
import type { AgenteCheckpointSummary, AgenteRuntimeMode, AgenteStartSessionArgs, ApprovalDecision, CodeAgentEvent } from '../../shared/agente-protocol.ts';
import type { Attachment, Message, RuntimeEventEnvelope, SessionSnapshot, TurnMode } from '../../shared/agente-protocol.gen.ts';

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
  followUps: string[];
  contextWindow: number;
  translator: RustTurnTranslator;
  checkpoints: AgenteCheckpointSummary[];
};

const chats = new Map<string, ChatState>();
let daemon: AgenteDaemon | null = null;
let listening: AgenteClient | null = null;
let desktopTools: Promise<DesktopToolServer> | null = null;

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

async function connect(): Promise<AgenteClient> {
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
    client.onNotification((method, params) => {
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
  }
  return client;
}

/**
 * Hand the runtime Desktop's provider (with its key, over the socket only)
 * and return the id and model a turn should name.
 */
export async function useProvider(client: AgenteClient, providerName: string, model: string): Promise<{ id: string; model: string }> {
  const provider = providerEntry(providerName, model);
  if (provider.model) await client.request('runtime.configure', { provider: { [provider.id]: provider.config } });
  return { id: provider.id, model: provider.model };
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
  if (next !== undefined) void prompt(chat.chatId, next);
}

function route(envelope: RuntimeEventEnvelope): void {
  const chat = [...chats.values()].find((state) => state.sessionId === envelope.session_id);
  if (!chat) return;
  for (const event of chat.translator.translate(envelope)) {
    if (event.type === 'checkpoint_finalized') recordCheckpoint(chat, event);
    emit(event);
    // A command may have left a server running in the background.
    if (event.type === 'tool_end') rustProcesses.nudge();
    if (event.type === 'agent_end') continueWithFollowUp(chat);
  }
}

const TURN_MODES: Record<AgenteRuntimeMode, TurnMode> = { full: 'auto', supervised: 'build', plan: 'plan' };

/** Desktop's provider and model, as a provider entry for runtime.configure. */
function providerEntry(providerName: string, model: string): { id: string; config: Record<string, unknown>; model: string } {
  const transport = resolveTransport(providerName, model);
  const id = `desktop-${transport.providerName}`;
  const apiKey = resolveApiKey('', transport.baseUrl, transport.providerName) || undefined;
  return {
    id,
    model: transport.model,
    config: {
      name: transport.providerName,
      api_format: 'openai',
      options: { baseURL: transport.baseUrl, ...(apiKey ? { apiKey } : {}) },
      models: { [transport.model]: { name: transport.model } }
    }
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

async function startSession(args: AgenteStartSessionArgs): Promise<{ sessionId: string; resumed: boolean }> {
  const client = await connect();
  const sessionId = args.resumeSessionId && UUID.test(args.resumeSessionId) ? args.resumeSessionId : crypto.randomUUID();
  const existing = await client.request<{ snapshot: SessionSnapshot }>('session.get', { session_id: sessionId });
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
  return { sessionId, resumed };
}

async function prompt(chatId: string, text: string, images?: Array<{ data: string; mimeType: string }>): Promise<{ ok: boolean; error?: string }> {
  const chat = chats.get(chatId);
  if (!chat) return { ok: false, error: 'No active agente session for this chat' };
  try {
    const client = await connect();
    activeChat = chat;
    const provider = await useProvider(client, chat.provider, chat.model);
    if (!provider.model) return { ok: false, error: 'No model selected — pick one in the Model Hub first.' };
    const message: Message = { role: 'user', content: text, attachments: storeImages(images) };
    const started = await client.request<{ turn_id: string }>('turn.start', turnParams(chat, provider, message));
    chat.systemPrompt = undefined;
    chat.turnId = started.turn_id;
    return { ok: true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: 'error', chatId, message });
    return { ok: false, error: message };
  }
}

function steer(chatId: string, text: string): { ok: boolean } {
  const chat = chats.get(chatId);
  if (!chat) return { ok: false };
  if (!chat.turnId) return followUp(chatId, text);
  void connect().then((client) => client.request('turn.steer', { turn_id: chat.turnId, content: text })).catch(() => {});
  return { ok: true };
}

function followUp(chatId: string, text: string): { ok: boolean } {
  const chat = chats.get(chatId);
  if (!chat) return { ok: false };
  if (chat.turnId) chat.followUps.push(text);
  else void prompt(chatId, text);
  return { ok: true };
}

function abort(chatId: string): { ok: boolean } {
  const chat = chats.get(chatId);
  if (!chat?.turnId) return { ok: false };
  chat.followUps = [];
  void connect().then((client) => client.request('turn.cancel', { turn_id: chat.turnId })).catch(() => {});
  return { ok: true };
}

function respondApproval(chatId: string, requestId: string, decision: ApprovalDecision): { ok: boolean } {
  if (!chats.has(chatId)) return { ok: false };
  void connect()
    .then((client) => client.request('approval.respond', { request_id: requestId, decision: decision === 'allow' ? 'approve_once' : 'deny' }))
    .catch(() => {});
  emit({ type: 'approval_resolved', chatId, requestId, decision });
  return { ok: true };
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

async function listCheckpoints(chatId: string): Promise<AgenteCheckpointSummary[]> {
  return chats.get(chatId)?.checkpoints ?? [];
}

/**
 * Put the files back to how they were before `turnIndex`: undo the edits of
 * that turn and every later one, newest first. The conversation is kept.
 */
async function rollback(chatId: string, turnIndex: number): Promise<{ ok: boolean; restored?: number; files?: string[]; error?: string }> {
  const chat = chats.get(chatId);
  if (!chat) return { ok: false, error: 'No checkpoints for this conversation' };
  const later = chat.checkpoints.filter((checkpoint) => checkpoint.turnIndex >= turnIndex);
  try {
    const client = await connect();
    const files = new Set<string>();
    for (let i = 0; i < later.length; i += 1) {
      const undone = await client.request<{ paths: string[] }>('edits.undo', { session_id: chat.sessionId });
      for (const file of undone.paths) files.add(file);
    }
    chat.checkpoints = chat.checkpoints.filter((checkpoint) => checkpoint.turnIndex < turnIndex);
    return { ok: true, restored: files.size, files: [...files] };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function liveChatIds(): string[] {
  return [...chats.keys()];
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
  listCheckpoints,
  rollback,
  liveChatIds,
  deleteSessionData,
  disposeAllSessions
};

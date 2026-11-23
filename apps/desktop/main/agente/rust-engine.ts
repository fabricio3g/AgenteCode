// ── Code section on the Rust runtime ───────────────────────────────────
// Every Code chat runs on the Rust runtime (`agente serve`): each chat is a
// runtime session, Desktop's providers are handed over with
// runtime.configure, and the runtime's events are translated back into the
// CodeAgentEvent stream the UI renders.

import crypto from 'node:crypto';
import { conversationScope } from '../../shared/workspace-scope.ts';
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, type WebContents } from 'electron';
import { createComputerTools } from './tools/computer.ts';
import { bindComputerOwner, cancelComputerTurn, settleComputerTurn, computerSession, type ComputerOwner } from '../computer/desktop.ts';
import { resolveApiKey } from '../provider-auth.ts';
import { getAppPaths } from '../paths.ts';
import { forgetProviderKey, loadConfig, saveConfig } from '../config.ts';
import { getLlamaStatus, getPendingMainLaunch, startLlama } from '../llm-runner.ts';
import { moduleDirname } from '../module-env.ts';
import { AgenteDaemon, resolveAgenteBinary } from '../agente-daemon.ts';
import type { AgenteClient } from '../agente-client.ts';
import { emitCodeAgentEvent, getCodeMainWindow } from './event-bridge.ts';
import { createProviderPreflight, RuntimeNoModelError } from './provider-preflight.ts';
import { resolveContextWindow, resolveTransport, transportSeesImages } from './transport.ts';
import { createBrowserTools } from './tools/browser.ts';
import { createDomainTools, domainService } from '../domains/desktop.ts';
import { serveDesktopTools, type DesktopToolServer } from './desktop-tools-mcp.ts';
import { RustProcessBridge } from './rust-processes.ts';
import { RustTurnTranslator } from './rust-events.ts';
import { coreProviderStatus, migrateKeysToCore } from './core-providers.ts';
import { resetWebSearchSync, syncWebSearchToCore } from './core-web.ts';
import { modelTransportConfig, providerTransportPolicy, type ModelTransport } from './model-transport.ts';
import type { AgenteCheckpointSummary, AgenteRuntimeMode, AgenteStartSessionArgs, ApprovalDecision, CodeAgentEvent, LocalModelSelection, SubagentModelEntry, SubagentSettings } from '../../shared/agente-protocol.ts';
import type { Attachment, Message, RuntimeEventEnvelope, SessionSnapshot, TurnMode, TurnOutcome } from '../../shared/agente-protocol.gen.ts';
import { trackGoalTurn, goalTurnStarted } from '../session-goals.ts';

const FALLBACK_CONTEXT_WINDOW = 32_768;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ChatState = {
  owner?: WebContents;
  unbindOwner?: () => void;
  chatId: string;
  sessionId: string;
  projectRoot: string;
  provider: string;
  model: string;
  localSelection?: LocalModelSelection;
  thinkingLevel?: string;
  mode: AgenteRuntimeMode;
  /** Sent with the first turn of a new session only. */
  systemPrompt?: string;
  turnId: string | null;
  stopRequested: boolean;
  stopGrace?: ReturnType<typeof setTimeout>;
  settlement?: { promise: Promise<void>; resolve: () => void };
  followUps: Array<{ text: string; attachments: Attachment[] }>;
  contextWindow: number;
  translator: RustTurnTranslator;
  checkpoints: AgenteCheckpointSummary[];
};

const chats = new Map<string, ChatState>();
const chatsBySession = new Map<string, ChatState>();
const manualCompactions = new Set<string>();
const attachedClients = new WeakSet<AgenteClient>();
let daemon: AgenteDaemon | null = null;
let listening: AgenteClient | null = null;
let desktopTools: Promise<DesktopToolServer> | null = null;
let connectionPromise: Promise<AgenteClient> | null = null;

function clearStopGrace(chat: ChatState): void {
  if (chat.stopGrace) {
    clearTimeout(chat.stopGrace);
    chat.stopGrace = undefined;
  }
}

const ensureProvider = createProviderPreflight({
  localConfig: () => (loadConfig().llm?.local ?? {}) as Record<string, unknown>,
  status: getLlamaStatus,
  pendingLaunch: getPendingMainLaunch,
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

/**
 * Serve Desktop-only tools (the in-app browser) to the runtime as the MCP
 * server `desktop`: they show up in the loop as desktop_browser_open, …
 */
async function registerDesktopTools(client: AgenteClient): Promise<void> {
  desktopTools ??= serveDesktopTools(
    [...createBrowserTools({
      canSeeImages: async (context) => {
        const chat = chatsBySession.get(context.sessionId);
        return !!chat && (await modelSeesImages(chat.provider, chat.model));
      }
    }), ...createDomainTools(), ...createComputerTools({
      owner: context => { const chat = chatsBySession.get(context.sessionId); return chat && context.computerTurnId === chat.turnId ? codeComputerOwner(chat) : undefined; },
      canSeeImages: async context => { const chat = chatsBySession.get(context.sessionId); return !!chat && await modelSeesImages(chat.provider, chat.model); },
    })],
    { resolveContext: async (meta) => {
      const sid = typeof meta['agente/sessionId'] === 'string' ? meta['agente/sessionId'] : '';
      const chat = chatsBySession.get(sid);
      if (chat) return { sessionId: chat.sessionId, computerTurnId: typeof meta['agente/turnId'] === 'string' ? meta['agente/turnId'] : undefined, browserScope: conversationScope(chat.chatId), workspaceRoot: chat.projectRoot };
      throw new Error('Browser call has no owning conversation');
    } }
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

/** The `agente` binary this app runs: bundled, or the repo's own build. */
export function desktopAgenteBinary(): string | null {
  return resolveAgenteBinary({
    resourcesPath: typeof process.resourcesPath === 'string' ? process.resourcesPath : undefined,
    repoRoot: findRepoRoot(moduleDirname(import.meta.url))
  });
}

async function openConnection(): Promise<AgenteClient> {
  if (!daemon) {
    daemon = new AgenteDaemon({ binary: desktopAgenteBinary(), socketPath: process.env.AGENTE_SMOKE_SOCKET });
  }
  const client = await daemon.connect();
  if (listening !== client) {
    if (!attachedClients.has(client)) {
      attachedClients.add(client);
      client.onClose(() => {
        if (listening !== client) return;
        listening = null;
        connectionPromise = null;
        configured.clear();
        resetWebSearchSync();
        for (const chat of chats.values()) {
          clearStopGrace(chat);
          if (!chat.turnId) continue;
          cancelComputerTurn(chat.sessionId, 'runtime_disconnected');
          settleComputerTurn(chat.sessionId, chat.turnId);
          chat.turnId = null;
          chat.settlement?.resolve();
          chat.settlement = undefined;
          chat.followUps = [];
          emit({ type: 'error', chatId: chat.chatId, message: 'The Rust runtime disconnected. Reconnect by sending a new message.' });
          emit({ type: 'agent_end', chatId: chat.chatId, stopReason: 'error' });
        }
      });
      client.onNotification((method, params) => {
        if (method === 'turn.outcome') {
          const outcome = params as TurnOutcome;
          const chat = chatsBySession.get(outcome.session_id);
          if (chat && (!chat.turnId || chat.turnId === outcome.turn_id)) continueWithFollowUp(chat, outcome.status === 'completed');
          return;
        }
        if (method === 'events.lagged') {
          const skipped = (params as { skipped?: number } | undefined)?.skipped;
          console.warn(`[agente] daemon event stream lagged (skipped=${skipped ?? 'unknown'}); nudging process bridge`);
          rustProcesses.nudge();
          return;
        }
        if (method !== 'event') return;
        const envelope = params as RuntimeEventEnvelope;
        route(envelope);
      });
    }
    // Turns started by another client arrive this way;
    // the runtime never sends a turn twice to the client that started it.
    await client.request('events.subscribe', {}).catch(() => {});
    await registerDesktopTools(client).catch((error: unknown) => {
      console.warn(`[agente] desktop tools unavailable: ${error instanceof Error ? error.message : String(error)}`);
    });
    void migrateKeysToCore(client, (loadConfig().llm?.providers || {}) as Record<string, { api_key?: string }>, forgetProviderKey).catch((error: unknown) => {
      console.warn(`[agente] provider keys stay in Desktop for now: ${error instanceof Error ? error.message : String(error)}`);
    });
    void syncWebSearchToCore(async () => client, loadConfig().search).catch((error: unknown) => {
      console.warn(`[agente] web search settings not synced: ${error instanceof Error ? error.message : String(error)}`);
    });
    const saved = loadConfig().agent_runtime as Record<string, unknown> | undefined;
    if (saved) {
      const overrides = saved.subagent_models as Record<string, { provider: string; model: string }> | undefined;
      const listed = (saved.subagents as SubagentSettings | undefined)?.models ?? [];
      for (const model of [...Object.values(overrides || {}), ...listed, ...(saved.compaction_model ? [saved.compaction_model as { provider: string; model: string }] : [])]) {
        if (model?.provider?.startsWith('desktop-')) {
          try {
            await useProvider(client, model.provider.slice(8), model.model);
          } catch (error: unknown) {
            console.warn(`[agente] skipped restoring model ${model.provider}/${model.model}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      await client.request('runtime.configure', saved);
    }
    listening = client;
  }
  return client;
}

/**
 * The id and model a turn should name. A provider the core offers and holds
 * a key for runs on the core's own spec and key, as in the TUI; anything
 * else (local llama.cpp, custom endpoints) is handed over as Desktop's
 * provider, its key over the socket only.
 */
export async function useProvider(client: AgenteClient, providerName: string, model: string, selection?: LocalModelSelection): Promise<{ id: string; model: string }> {
  const resolved = resolveTransport(providerName, model, selection);
  await ensureProvider(resolved);
  if (resolved.providerName === 'local' && !resolved.model) model = String(getLlamaStatus().model_id || '');
  const provider = providerEntry(providerName, model, selection);
  if (!provider.model) throw new RuntimeNoModelError(desktopLocale());
  const transport = resolveTransport(providerName, model, selection);
  if (await coreRuns(client, transport.providerName)) return { id: transport.providerName, model: provider.model };
  const info = await client.request<{ capabilities: Record<string, unknown>; cost: unknown; limits: unknown; reasoning_options?: unknown; reasoning_stream_field?: string; transport?: ModelTransport }>('models.info', { provider: transport.providerName, model: provider.model });
  const capabilities = providerCapabilities(transport, info.capabilities);
  const limit = transport.providerName === 'local' ? localLimits(info.limits, Number(getLlamaStatus().n_ctx) || await resolveContextWindow(transport)) : info.limits;
  provider.config.transport = providerTransportPolicy(transport.baseUrl, info.transport);
  provider.config.models = { [provider.model]: { name: provider.model, ...modelTransportConfig(transport.baseUrl, provider.config.api_format, info.transport), capabilities, cost: info.cost, limit, reasoning_options: info.reasoning_options, reasoning_stream_field: info.reasoning_stream_field } };
  await configureDesktopProvider(client, provider.id, provider.config);
  return { id: provider.id, model: provider.model };
}

/** Desktop provider entries the runtime holds, by id; a new daemon starts without them. */
const configured = new Map<string, Record<string, unknown>>();

/**
 * Hand the runtime a Desktop provider entry. It replaces an entry whole, so
 * this one keeps every model the provider was configured with — otherwise a
 * subagent or compaction model pinned there lost its route, window and
 * thinking options at the next prompt. `held` keeps the richer entries
 * already there; by default the new ones win.
 * Every configure rebuilds the runtime's provider registry, so an unchanged
 * entry is not sent again.
 */
async function configureDesktopProvider(client: Pick<AgenteClient, 'request'>, id: string, config: Record<string, unknown>, prefer: 'new' | 'held' = 'new'): Promise<void> {
  const held = configured.get(id);
  const fresh = (config.models ?? {}) as Record<string, unknown>;
  const kept = (held?.models ?? {}) as Record<string, unknown>;
  const next = prefer === 'held' && held
    ? { ...held, options: config.options, models: { ...fresh, ...kept } }
    : { ...config, models: { ...kept, ...fresh } };
  if (held && JSON.stringify(held) === JSON.stringify(next)) return;
  await client.request('runtime.configure', { provider: { [id]: next } });
  configured.set(id, next);
}

/**
 * A local model's real window (llama-server's per-slot `n_ctx`, else the
 * configured context length). The runtime has no other source and assumed
 * 128k, so it never compacted and an 8k–32k server overflowed and dropped turns.
 */
function localLimits(limits: unknown, context: number): unknown {
  const current = (limits && typeof limits === 'object' ? limits : {}) as { output?: unknown };
  const output = Number(current.output) || 0;
  // The reply reserve is at most a quarter of the window. Keeping a catalog
  // output of 4k on an 8k server left 4k for the system prompt and tool
  // schemas, and "Hello" overflowed.
  const reserve = Math.floor(context / 4);
  return { ...current, context, output: output > 0 ? Math.min(output, reserve) : reserve };
}

async function coreRuns(client: AgenteClient, providerId: string): Promise<boolean> {
  if (providerId === 'local') return false;
  const status = await coreProviderStatus(client).catch(() => null);
  return !!status?.providers.some((entry) => entry.id === providerId && entry.connected);
}

const imageSupport = new Map<string, true>();

/** Whether a model takes images (screenshots): see {@link modelInputs}. */
export async function modelSeesImages(providerName: string, model: string): Promise<boolean> {
  const transport = resolveTransport(providerName, model);
  const key = `${transport.providerName}::${transport.model || model}`;
  if (imageSupport.get(key)) return true;
  const sees = (await modelInputs(providerName, model)).includes('image');
  // Only a yes is kept: the provider's live list can arrive after a
  // models.dev "no" (it did for OpenCode Go's space-bunny).
  if (sees && transport.providerName !== 'local') imageSupport.set(key, true);
  return sees;
}

/**
 * What a model takes as input (`text`, `image`, `audio`, `video`, `pdf`),
 * from the core's model data; a local model sees images when it has a
 * vision projector. The name guess is the fallback only when the core
 * cannot be asked.
 */
async function modelInputs(providerName: string, model: string): Promise<string[]> {
  const transport = resolveTransport(providerName, model);
  const guess = transportSeesImages(transport) ? ['text', 'image'] : ['text'];
  if (transport.providerName === 'local') return guess;
  try {
    const client = await connect();
    const info = await client.request<{ capabilities?: { vision?: boolean; input_modalities?: string[] } }>('models.info', { provider: transport.providerName, model: transport.model || model });
    const kinds = info.capabilities?.input_modalities?.length ? info.capabilities.input_modalities : ['text'];
    return info.capabilities?.vision && !kinds.includes('image') ? [...kinds, 'image'] : kinds;
  } catch {
    return guess;
  }
}

function providerCapabilities(transport: ReturnType<typeof resolveTransport>, source: Record<string, unknown>): Record<string, unknown> {
  const capabilities = { ...source };
  if (transport.providerName !== 'local') return capabilities;
  const modalities = getLlamaStatus().modalities;
  capabilities.vision = transportSeesImages(transport);
  capabilities.input_modalities = Array.isArray(modalities) ? modalities : capabilities.vision ? ['text', 'image'] : ['text'];
  return capabilities;
}

/** The runtime connection, started on first use. */
export function runtimeConnection(): Promise<AgenteClient> {
  return connect();
}

function emit(event: CodeAgentEvent, chat?: ChatState): void {
  const ownerWin = chat?.owner && !chat.owner.isDestroyed() ? BrowserWindow.fromWebContents(chat.owner) : null;
  emitCodeAgentEvent(ownerWin ?? getCodeMainWindow(), event);
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
function continueWithFollowUp(chat: ChatState, completed: boolean): void {
  clearStopGrace(chat);
  if (chat.turnId) settleComputerTurn(chat.sessionId, chat.turnId);
  chat.turnId = null;
  chat.settlement?.resolve();
  chat.settlement = undefined;
  if (!completed || chat.stopRequested) { chat.followUps = []; return; }
  const next = chat.followUps.shift();
  if (next !== undefined) void prompt(chat.chatId, next.text, undefined, next.attachments);
}

function route(envelope: RuntimeEventEnvelope): void {
  const chat = chatsBySession.get(envelope.session_id);
  if (!chat) return;
  if (envelope.event.type === 'context_compacted' && manualCompactions.has(chat.sessionId)) return;
  if (['turn_finished', 'turn_cancelled', 'turn_failed'].includes(envelope.event.type) && !chat.settlement) {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    chat.settlement = { promise, resolve };
  }
  if (envelope.event.type === 'turn_started' && !envelope.parent_run_id) chat.turnId = envelope.turn_id;
  for (const event of chat.translator.translate(envelope)) {
    if (event.type === 'checkpoint_finalized') recordCheckpoint(chat, event);
    emit(event, chat);
    // A command may have left a server running in the background.
    if (event.type === 'tool_end') rustProcesses.nudge();
  }
}

const TURN_MODES: Record<AgenteRuntimeMode, TurnMode> = { full: 'auto', supervised: 'build', plan: 'plan' };

/** Desktop's provider and model, as a provider entry for runtime.configure. */
function providerEntry(providerName: string, model: string, selection?: LocalModelSelection): { id: string; config: Record<string, unknown>; model: string } {
  const transport = resolveTransport(providerName, model, selection);
  return {
    id: `desktop-${transport.providerName}`,
    model: transport.model,
    config: providerConfig(providerName, [transport.model], selection)
  };
}

/** A provider as the runtime takes it: Desktop's endpoint and key, and these models. */
function providerConfig(providerName: string, models: string[], selection?: LocalModelSelection): Record<string, unknown> {
  const transport = resolveTransport(providerName, models[0], selection);
  const apiKey = resolveApiKey('', transport.baseUrl, transport.providerName) || undefined;
  return {
    name: transport.providerName,
    api_format: 'openai',
    options: { baseURL: transport.baseUrl, ...(apiKey ? { apiKey } : {}) },
    models: Object.fromEntries(models.map((model) => [model, { name: model }]))
  };
}

/** Pasted images become stored files in the Rust core's content-addressed media store. */
async function storeImages(client: AgenteClient, images: Array<{ data: string; mimeType: string }> | undefined): Promise<Attachment[]> {
  if (!images?.length) return [];
  return Promise.all(images.map(async (image, index) => {
    const extension = image.mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png';
    const name = `image-${index + 1}.${extension}`;
    try {
      const imported = await client.request<{ attachment: Attachment }>('media.import', { name, data: image.data });
      if (imported?.attachment) return imported.attachment;
    } catch {
      // Fallback to local appData attachment file only if daemon media.import fails.
    }
    const dir = path.join(getAppPaths().appData, 'agente', 'attachments');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${crypto.randomUUID()}.${extension}`);
    const bytes = Buffer.from(image.data.replace(/^data:[^,]*,/, ''), 'base64');
    fs.writeFileSync(file, bytes);
    return { kind: 'image', mime: image.mimeType, name, path: file, bytes: bytes.length };
  }));
}

/**
 * The window the runtime itself compacts against (models.info: registry,
 * live discovery, models.dev) — so the meter and compaction agree. Desktop's
 * own lookup is only the fallback when the runtime has no answer.
 */
async function runtimeContextWindow(chat: ChatState): Promise<number | null> {
  const transport = resolveTransport(chat.provider, chat.model, chat.localSelection);
  if (transport.providerName === 'local') return null;
  const client = await connect();
  const info = await client.request<{ limits?: { context?: number } }>('models.info', { provider: transport.providerName, model: transport.model || chat.model });
  const context = Number(info.limits?.context);
  return Number.isFinite(context) && context > 0 ? context : null;
}

function refreshContextWindow(chat: ChatState): void {
  void runtimeContextWindow(chat)
    .catch(() => null)
    .then((window) => window ?? resolveContextWindow(resolveTransport(chat.provider, chat.model, chat.localSelection)))
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

function codeComputerOwner(chat: ChatState): ComputerOwner | undefined {
  if (!chat.owner || chat.owner.isDestroyed() || !chat.turnId) return undefined;
  return { sessionId: chat.sessionId, turnId: chat.turnId, chatId: chat.chatId, space: 'code', webContentsId: chat.owner.id,
    stop: () => { void abort(chat.chatId); }, resume: () => { if (chat.owner && !chat.owner.isDestroyed()) chat.owner.send('computer_resume', { chatId: chat.chatId, space: 'code' }); } };
}
function unbindChatWindow(chat: ChatState): void {
  chat.unbindOwner?.();
  chat.unbindOwner = undefined;
  chat.owner = undefined;
}
function bindChatWindow(chat: ChatState, owner?: WebContents) {
  if (!owner || chat.owner === owner) return;
  if (chat.owner && (chat.turnId || computerSession.owner?.sessionId === chat.sessionId)) throw new Error('This Code chat is active in another window.');
  unbindChatWindow(chat);
  chat.owner = owner;
  const release = () => {
    unbindChatWindow(chat);
    computerSession.releaseOwner(owner.id);
    void abort(chat.chatId);
  };
  owner.once('destroyed', release);
  owner.once('render-process-gone', release);
  chat.unbindOwner = () => {
    owner.removeListener('destroyed', release);
    owner.removeListener('render-process-gone', release);
  };
}
async function startSession(args: AgenteStartSessionArgs, owner?: WebContents): Promise<{ sessionId: string; resumed: boolean; conversationIndex: number }> {
  await ensureProvider(resolveTransport(args.provider, args.model, args.localSelection));
  const live = chats.get(args.chatId);
  if (live) {
    bindChatWindow(live, owner);
    Object.assign(live, { provider: args.provider, model: args.model, mode: args.runtimeMode, thinkingLevel: args.thinkingLevel, localSelection: args.localSelection });
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
    localSelection: args.localSelection,
    thinkingLevel: args.thinkingLevel,
    mode: args.runtimeMode,
    systemPrompt: resumed ? undefined : args.systemPromptOverride,
    turnId: null,
    stopRequested: false,
    followUps: [],
    contextWindow: FALLBACK_CONTEXT_WINDOW,
    translator: undefined as unknown as RustTurnTranslator,
    checkpoints: []
  };
  chat.translator = new RustTurnTranslator(args.chatId, () => chat.contextWindow);
  const existingChat = chats.get(args.chatId);
  if (existingChat && existingChat.sessionId !== sessionId) chatsBySession.delete(existingChat.sessionId);
  chats.set(args.chatId, chat);
  chatsBySession.set(sessionId, chat);
  bindChatWindow(chat, owner);
  refreshContextWindow(chat);
  return { sessionId, resumed, conversationIndex: existing.snapshot.conversation.length };
}

async function prompt(chatId: string, text: string, images?: Array<{ data: string; mimeType: string }>, attachments: Attachment[] = [], owner?: WebContents): Promise<{ ok: boolean; error?: string; errorKey?: string; conversationIndex?: number }> {
  const chat = chats.get(chatId);
  if (!chat) return { ok: false, error: 'No active agente session for this chat' };
  bindChatWindow(chat, owner);
  clearStopGrace(chat);
  chat.stopRequested = false;
  try {
    // The terminal event reaches the renderer before the runtime releases its turn slot.
    // Wait for turn.outcome before starting the next queued prompt.
    if (chat.settlement) await chat.settlement.promise;
    await ensureProvider(resolveTransport(chat.provider, chat.model, chat.localSelection));
    const client = await connect();
    const provider = await useProvider(client, chat.provider, chat.model, chat.localSelection);
    const expanded = await client.request<{ text: string }>('project.expand_prompt', { project_dir: chat.projectRoot, text });
    const media = [...attachments, ...(await storeImages(client, images))];
    if (media.length) {
      const info = await client.request<{ capabilities: { input_modalities?: string[]; vision: boolean } }>('models.info', { provider: provider.id, model: provider.model });
      const modalities = info.capabilities.input_modalities || [];
      const unsupported = media.filter((item) => modalities.length ? !modalities.includes(item.kind) && !(item.kind === 'pdf' && modalities.includes('file')) : item.kind !== 'image' || !info.capabilities.vision);
      if (unsupported.length) throw new Error(`The selected model cannot accept ${unsupported.map((item) => item.name).join(', ')}. Choose a model with those input modalities.`);
    }
    const message: Message = { role: 'user', content: expanded.text, attachments: media };
    if (chat.owner) trackGoalTurn(chat.sessionId, client, chat.owner, provider.id, provider.model, message.content);
    const started = await client.request<{ turn_id: string; conversation_index?: number }>('turn.start', turnParams(chat, provider, message));
    chat.systemPrompt = undefined;
    chat.turnId = started.turn_id;
    goalTurnStarted(chat.sessionId,started.turn_id);
    const computerOwner = codeComputerOwner(chat); if (computerOwner) bindComputerOwner(computerOwner);
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
  if (!chat || chat.stopRequested) return { ok: false };
  if (!chat.turnId) return queueFollowUp(chat, text, attachments);
  const turnId = chat.turnId;
  const client = await connect();
  const expanded = await client.request<{ text: string }>('project.expand_prompt', { project_dir: chat.projectRoot, text });
  if (chat.stopRequested || chat.turnId !== turnId) return { ok: false };
  return client.request('turn.steer', { turn_id: turnId, content: expanded.text, attachments });
}

async function followUp(chatId: string, text: string, attachments: Attachment[] = []): Promise<{ ok: boolean }> {
  const chat = chats.get(chatId);
  return chat ? queueFollowUp(chat, text, attachments) : { ok: false };
}

async function queueFollowUp(chat: ChatState, text: string, attachments: Attachment[]): Promise<{ ok: boolean }> {
  if (chat.stopRequested) return { ok: false };
  if (!chat.turnId) return prompt(chat.chatId, text, undefined, attachments);
  chat.followUps.push({ text, attachments });
  return { ok: true };
}

/** How long Stop waits for the runtime to end the turn before the UI settles on its own. */
const STOP_GRACE_MS = 4_000;

/**
 * Stop always stops, as far as the window is concerned: a turn the runtime
 * no longer knows (it ended while the window missed it, the runtime
 * restarted) or one that does not end soon after the cancel is closed here
 * as stopped, instead of leaving a run spinning that nothing can end.
 */
async function abort(chatId: string): Promise<{ ok: boolean }> {
  const chat = chats.get(chatId);
  if (!chat) return { ok: false };
  chat.stopRequested = true;
  cancelComputerTurn(chat.sessionId);
  domainService().jobs.cancelOwner(chat.sessionId);
  void desktopTools?.then(server => server.cancelSession(chat.sessionId));
  chat.followUps = [];
  const turnId = chat.turnId;
  if (!turnId) {
    settleStopped(chat);
    return { ok: true };
  }
  // Armed before any await: a runtime that never answers cannot hold it up.
  clearStopGrace(chat);
  const grace = setTimeout(() => {
    if (chat.stopGrace === grace) chat.stopGrace = undefined;
    if (chat.turnId === turnId) settleStopped(chat);
  }, STOP_GRACE_MS);
  chat.stopGrace = grace;
  let cancelled = false;
  try {
    const client = await connect();
    cancelled = (await client.request<{ ok: boolean }>('turn.cancel', { turn_id: turnId })).ok;
  } catch {
    cancelled = false;
  }
  if (!cancelled && chat.turnId === turnId) {
    settleStopped(chat);
  }
  return { ok: true };
}

function settleStopped(chat: ChatState): void {
  clearStopGrace(chat);
  if (chat.turnId) settleComputerTurn(chat.sessionId, chat.turnId);
  chat.turnId = null;
  chat.settlement?.resolve();
  chat.settlement = undefined;
  emit({ type: 'agent_end', chatId: chat.chatId, stopReason: 'aborted' });
}

async function respondApproval(chatId: string, requestId: string, decision: ApprovalDecision): Promise<{ ok: boolean }> {
  if (!chats.has(chatId)) return { ok: false };
  const client = await connect();
  const result = await client.request<{ ok: boolean }>('approval.respond', { request_id: requestId, decision: decision === 'allow' ? 'approve_once' : 'deny' });
  if (result.ok) emit({ type: 'approval_resolved', chatId, requestId, decision });
  return result;
}

async function setRuntimeMode(chatId: string, mode: AgenteRuntimeMode): Promise<{ ok: boolean }> {
  const chat = chats.get(chatId);
  if (!chat) return { ok: false };
  chat.mode = mode;
  if (chat.turnId) await (await connect()).request('turn.update', { turn_id: chat.turnId, mode: TURN_MODES[mode] });
  return { ok: true };
}

async function setModel(chatId: string, provider: string, model: string, thinkingLevel?: string, localSelection?: LocalModelSelection): Promise<{ ok: boolean }> {
  const chat = chats.get(chatId);
  if (!chat) return { ok: false };
  const thinkingChanged = chat.thinkingLevel !== thinkingLevel;
  Object.assign(chat, { provider, model, thinkingLevel, localSelection });
  if (chat.turnId && thinkingChanged) await (await connect()).request('turn.update', { turn_id: chat.turnId, thinking_level: thinkingLevel ?? 'auto' });
  refreshContextWindow(chat);
  return { ok: true };
}

async function compact(chatId: string, smart = true): Promise<{ ok: boolean; error?: string }> {
  const chat = chats.get(chatId);
  if (!chat) return { ok: false, error: 'No active session' };
  emit({ type: 'compaction_start', chatId, reason: 'manual' });
  manualCompactions.add(chat.sessionId);
  try {
    const client = await connect();
    const result = await client.request<{ compaction: { summary?: string | null; tokens_before: number; tokens_after: number; smart: boolean; requested_smart: boolean; model_tokens: number | null; input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; cache_creation_tokens: number | null } }>('session.compact', { session_id: chat.sessionId, smart });
    emit({ type: 'compaction_end', chatId, reason: 'manual', success: true, tokensBefore: result.compaction.tokens_before, tokensAfter: result.compaction.tokens_after, smart: result.compaction.smart, summary: result.compaction.summary ?? undefined, requestedSmart: smart, modelTokens: result.compaction.model_tokens ?? undefined, inputTokens: result.compaction.input_tokens ?? undefined, outputTokens: result.compaction.output_tokens ?? undefined, cacheReadTokens: result.compaction.cache_read_tokens ?? undefined, cacheWriteTokens: result.compaction.cache_creation_tokens ?? undefined });
    return { ok: true };
  } catch (error: unknown) {
    emit({ type: 'compaction_end', chatId, reason: 'manual', success: false });
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    manualCompactions.delete(chat.sessionId);
  }
}

/** `!command` in the composer: run it in the project's shell, outside the model (owner only). */
async function exec(chatId: string, command: string): Promise<{ ok: boolean; error?: string }> {
  const chat = chats.get(chatId);
  if (!chat) return { ok: false, error: 'No active agente session for this chat' };
  clearStopGrace(chat);
  chat.stopRequested = false;
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

/**
 * Save the subagent model list. Each entry's provider is resolved the way a
 * turn's is — the core's own spec and key where it has one, otherwise handed
 * over as a Desktop provider — and the pre-list per-type pins are cleared,
 * since the list absorbs them. The runtime validates names.
 */
async function subagentSettings(next: SubagentSettings): Promise<{ ok: boolean }> {
  const client = await connect();
  const models: SubagentModelEntry[] = [];
  for (const entry of next.models ?? []) {
    const provider = await useProvider(client, entry.provider.replace(/^desktop-/, ''), entry.model);
    models.push({
      name: entry.name,
      provider: provider.id,
      model: provider.model,
      ...(entry.thinking ? { thinking: entry.thinking } : {}),
      ...(entry.use_for?.trim() ? { use_for: entry.use_for.trim() } : {})
    });
  }
  return configureSettings({ subagents: { ...next, models }, subagent_models: {} });
}

/** Persist only user settings; endpoint keys and Desktop's MCP token stay live. */
async function configureSettings(patch: Record<string, unknown>): Promise<{ ok: boolean }> {
  const allowed = ['smart_compaction', 'compaction_model', 'max_parallel_subagents', 'subagents', 'subagent_models', 'allow_media', 'approved_mcp_servers'];
  if (Object.keys(patch).some((key) => !allowed.includes(key))) throw new Error('Unknown agent setting.');
  if ('max_parallel_subagents' in patch && (!Number.isInteger(patch.max_parallel_subagents) || Number(patch.max_parallel_subagents) < 1 || Number(patch.max_parallel_subagents) > 32)) throw new Error('Choose 1–32 parallel subagents.');
  if (patch.compaction_model != null) {
    const chosen = patch.compaction_model as { provider?: unknown; model?: unknown; thinking?: unknown };
    if (typeof chosen.provider !== 'string' || typeof chosen.model !== 'string' || !chosen.provider.trim() || !chosen.model.trim()) throw new Error('Choose a compaction provider and model.');
    const target = await useProvider(await connect(), chosen.provider.replace(/^desktop-/, ''), chosen.model);
    patch = {
      ...patch,
      compaction_model: {
        provider: target.id,
        model: target.model,
        ...(typeof chosen.thinking === 'string' && chosen.thinking ? { thinking: chosen.thinking } : {})
      }
    };
  }
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
    if (chat) {
      clearStopGrace(chat);
      unbindChatWindow(chat);
      ids.add(chat.sessionId);
      chatsBySession.delete(chat.sessionId);
    }
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
  for (const chat of chats.values()) {
    clearStopGrace(chat);
    unbindChatWindow(chat);
    cancelComputerTurn(chat.sessionId, 'runtime_closed');
    if (chat.turnId) settleComputerTurn(chat.sessionId, chat.turnId);
  }
  chats.clear();
  chatsBySession.clear();
  resetWebSearchSync();
  daemon?.stop();
  daemon = null;
  listening = null;
  connectionPromise = null;
  rustProcesses.dispose();
  void desktopTools?.then((server) => server.close());
  desktopTools = null;
}

/** The engine behind every Code chat. */
export const rustEngine = {
  startSession,
  modelInputs,
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
  subagentSettings,
  configureSettings,
  listCheckpoints,
  rollback,
  liveChatIds,
  deleteSessionData,
  disposeAllSessions
};

// ── Agente runtime ─────────────────────────────────────────────────────
// One place that owns live sessions: builds Agents (tools + transport +
// hooks), bridges AgentEvents to the renderer's CodeAgentEvent stream,
// gates supervised-mode tool calls behind approvals, snapshots checkpoints,
// and persists the session tree. The renderer drives it through the
// agente_* IPC handlers.

import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfigFromDisk, updateConfig } from '../config.ts';
import { resolveApiKey } from '../chat-ipc.ts';
import { resolveProvider } from '../providers/registry.ts';
import { getAppPaths } from '../paths.ts';
import { Agent } from './core/agent.ts';
import type { AgentEvent, AgentTool, StreamFn } from './core/types.ts';
import type { AgentLoopHooks } from './core/agent-loop.ts';
import { createProviderStreamFn, type AgenteTransport } from './llm/stream-fn.ts';
import { ToolRegistry } from './tools/registry.ts';
import { createBuiltinTools } from './tools/builtins.ts';
import { CheckpointStore, type CheckpointSummary } from './tools/checkpoint.ts';
import { SessionTree, newSessionId, projectSlug } from './sessions/session-tree.ts';
import { buildAgenteSystemPrompt } from './prompts.ts';
import { ExtensionRunner } from './extensions/extension-runner.ts';
import { createBuiltinExtensions } from './extensions/builtin.ts';
import type { AgenteExtensionDefinition } from './extensions/extension-api.ts';
import { emitCodeAgentEvent } from './event-bridge.ts';
import type { CodeAgentEvent, AgenteSessionInfo, AgenteStartSessionArgs } from './types.ts';

const DEFAULT_MAX_TURNS = 40;
/** Assumed context window when the provider cannot tell us. */
const FALLBACK_CONTEXT_WINDOW = 32_768;

/**
 * Resolve the active model's context window: local runtime config first,
 * then a provider metadata lookup, then a conservative fallback.
 */
async function resolveContextWindow(transport: AgenteTransport): Promise<number> {
  const cfg = loadConfigFromDisk() as { llm?: Record<string, any> };
  const llm = cfg.llm ?? {};
  if (transport.providerName === 'local') {
    const local = Number(llm.local?.context_length);
    if (Number.isFinite(local) && local > 0) return local;
    return FALLBACK_CONTEXT_WINDOW;
  }
  try {
    const provider = resolveProvider(transport.providerName, transport.baseUrl);
    const apiKey = resolveApiKey('', transport.baseUrl, transport.providerName);
    if (!apiKey) return FALLBACK_CONTEXT_WINDOW;
    const metadata = await withTimeout(
      provider.fetchModelMetadata(apiKey, transport.baseUrl, transport.model),
      5000
    );
    const window = Number((metadata as { context_window?: number } | null)?.context_window);
    if (Number.isFinite(window) && window > 0) return window;
  } catch {
    // metadata is best-effort
  }
  return FALLBACK_CONTEXT_WINDOW;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

interface RuntimeSession {
  chatId: string;
  projectRoot: string;
  sessionId: string;
  agent: Agent;
  registry: ToolRegistry;
  tree: SessionTree;
  checkpoints: CheckpointStore | null;
  checkpointsEnabled: boolean;
  transport: AgenteTransport;
  runtimeMode: 'full' | 'supervised';
  systemPrompt: string;
  extensions: ExtensionRunner;
  /** Context window of the active model, for the usage ring. */
  contextWindow: number;
  /** 1-based index of the turn currently executing (0 between runs). */
  currentTurn: number;
  /** Files captured for the current turn's checkpoint. */
  capturedThisTurn: Set<string>;
  pendingApprovals: Map<string, (decision: 'allow' | 'deny') => void>;
  disposed: boolean;
}

const sessions = new Map<string, RuntimeSession>();

// ── Transport resolution ───────────────────────────────────────────────

const KNOWN_THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'max', 'enabled', 'disabled', 'on', 'none', 'default']);

function thinkingToReasoning(thinkingLevel?: string): AgenteTransport['reasoning'] {
  if (!thinkingLevel || !KNOWN_THINKING_LEVELS.has(thinkingLevel)) return null;
  return { level: thinkingLevel };
}

export function resolveTransport(providerName: string, modelOverride?: string, thinkingLevel?: string): AgenteTransport {
  const cfg = loadConfigFromDisk();
  const llm = (cfg as { llm?: Record<string, any> }).llm ?? {};
  const reasoning = thinkingToReasoning(thinkingLevel);

  if (providerName === 'local' || (!modelOverride && llm.backend_mode === 'local')) {
    const local = llm.local ?? {};
    const port = Number(local.port) || 11435;
    return {
      providerName: 'local',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: modelOverride || local.model || 'local-model',
      reasoning,
      params: {
        ...(Number.isFinite(local.temperature) ? { temperature: local.temperature } : {}),
        ...(local.max_tokens ? { max_tokens: local.max_tokens } : {})
      }
    };
  }

  const provider = (llm.providers ?? {})[providerName] ?? {};
  return {
    providerName,
    baseUrl: provider.base_url || 'https://api.openai.com/v1',
    model: modelOverride || provider.model || '',
    reasoning,
    params: {
      ...(Number.isFinite(provider.temperature) ? { temperature: provider.temperature } : {}),
      ...(provider.max_tokens ? { max_tokens: provider.max_tokens } : {}),
      ...(Number.isFinite(provider.top_p) ? { top_p: provider.top_p } : {})
    }
  };
}

// ── Event bridging ─────────────────────────────────────────────────────

function toCodeAgentEvent(chatId: string, event: AgentEvent): CodeAgentEvent | null {
  switch (event.type) {
    case 'agent_start':
      return { type: 'agent_start', chatId };
    case 'agent_end':
      return { type: 'agent_end', chatId };
    case 'turn_start':
      return { type: 'turn_start', chatId, turnIndex: event.turnIndex };
    case 'turn_end':
      return { type: 'turn_end', chatId, turnIndex: event.turnIndex };
    case 'text_delta':
      return { type: 'text_delta', chatId, delta: event.delta };
    case 'thinking_delta':
      return { type: 'thinking_delta', chatId, delta: event.delta };
    case 'tool_start':
      return { type: 'tool_start', chatId, toolCallId: event.toolCallId, toolName: event.toolName, args: event.args };
    case 'tool_update':
      return { type: 'tool_update', chatId, toolCallId: event.toolCallId, partialResult: event.partial };
    case 'tool_end':
      return { type: 'tool_end', chatId, toolCallId: event.toolCallId, result: event.result, isError: event.isError };
    case 'error':
      return { type: 'error', chatId, message: event.message };
    default:
      return null;
  }
}

function emit(session: RuntimeSession, event: CodeAgentEvent): void {
  emitCodeAgentEvent(null, event);
}

function emitUsage(session: RuntimeSession, usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }): void {
  emit(session, {
    type: 'usage',
    chatId: session.chatId,
    promptTokens: Number(usage.prompt_tokens ?? 0),
    completionTokens: Number(usage.completion_tokens ?? 0),
    totalTokens: Number(usage.total_tokens ?? 0),
    contextWindow: session.contextWindow
  });
}

/** Last persisted assistant usage in a session tree (resume path). */
function lastPersistedUsage(tree: SessionTree): { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null {
  for (let i = tree.listEntries().length - 1; i >= 0; i--) {
    const entry = tree.listEntries()[i]!;
    if (entry.kind !== 'assistant') continue;
    const usage = (entry.data as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } } | null)?.usage;
    if (usage && (usage.prompt_tokens || usage.total_tokens)) return usage;
  }
  return null;
}

// ── Approval + checkpoint hooks ────────────────────────────────────────

async function describeDiff(toolName: string, args: Record<string, unknown>): Promise<string | undefined> {
  if (toolName === 'edit') {
    const oldText = String(args.oldText ?? '');
    const newText = String(args.newText ?? '');
    return [
      `--- ${String(args.path ?? '')} (before)`,
      `+++ ${String(args.path ?? '')} (after)`,
      ...oldText.split('\n').map((line) => `-${line}`),
      ...newText.split('\n').map((line) => `+${line}`)
    ].join('\n');
  }
  if (toolName === 'write') {
    const content = String(args.content ?? '');
    const preview = content.split('\n').slice(0, 40).map((line) => `+${line}`).join('\n');
    return `${content.length > 0 ? 'Write/overwrite' : 'Create'} ${String(args.path ?? '')} (${content.length} bytes)\n${preview}`;
  }
  if (toolName === 'bash') {
    return `$ ${String(args.command ?? '')}`;
  }
  return undefined;
}

function buildHooks(session: RuntimeSession): AgentLoopHooks {
  return {
    beforeToolCall: async (toolCallId, toolName, args) => {
      const tool = session.registry.get(toolName);
      if (!tool) return;

      // 1. Extension policy hooks (cheap checks first).
      const extensionVerdict = await session.extensions.dispatch({ event: 'tool_call', toolName, args });
      if (extensionVerdict.block) {
        return { block: extensionVerdict.block };
      }

      // 2. Approval gate: supervised mode + mutating tool.
      if (session.runtimeMode === 'supervised' && tool.mutating) {
        const requestId = `apr-${crypto.randomUUID().slice(0, 8)}`;
        emit(session, {
          type: 'approval_request',
          chatId: session.chatId,
          requestId,
          toolName,
          args,
          diff: await describeDiff(toolName, args)
        });
        const decision = await new Promise<'allow' | 'deny'>((resolve) => {
          session.pendingApprovals.set(requestId, resolve);
        });
        session.pendingApprovals.delete(requestId);
        emit(session, { type: 'approval_resolved', chatId: session.chatId, requestId, decision });
        if (decision === 'deny') {
          return { block: 'The user denied this action. Ask how to proceed or choose a different approach.' };
        }
      }

      // Checkpoint capture: the file's pre-change state, once per turn.
      if (session.checkpointsEnabled && session.checkpoints && session.currentTurn > 0) {
        const rel = typeof args.path === 'string' ? args.path : null;
        if (rel && (toolName === 'write' || toolName === 'edit')) {
          try {
            const abs = path.resolve(session.projectRoot, rel);
            if (abs === session.projectRoot || abs.startsWith(session.projectRoot + path.sep)) {
              if (!session.capturedThisTurn.has(abs)) {
                session.capturedThisTurn.add(abs);
                await session.checkpoints.capture(abs, session.projectRoot, session.currentTurn);
                emit(session, {
                  type: 'checkpoint_captured',
                  chatId: session.chatId,
                  turnIndex: session.currentTurn,
                  fileCount: session.capturedThisTurn.size
                });
              }
            }
          } catch {
            // checkpointing is best-effort — never block the tool
          }
        }
      }
      return;
    },
    afterToolCall: async (toolCallId, toolName, result) => {
      const hook = await session.extensions.dispatch({ event: 'tool_result', toolName, result });
      if (hook.block || hook.content !== undefined || hook.isError !== undefined || hook.details !== undefined || hook.terminate) {
        return session.extensions.mergeToolResult(result, hook);
      }
      return;
    }
  };
}

function attachAgentListeners(session: RuntimeSession): void {
  session.agent.subscribe((event) => {
    const bridged = toCodeAgentEvent(session.chatId, event);
    if (bridged) emit(session, bridged);

    // Extension lifecycle hooks ride the same event stream.
    if (event.type === 'turn_start') {
      void session.extensions.dispatch({ event: 'turn_start', turnIndex: event.turnIndex });
    } else if (event.type === 'turn_end') {
      void session.extensions.dispatch({ event: 'turn_end', turnIndex: event.turnIndex });
    } else if (event.type === 'message_end') {
      void session.extensions.dispatch({ event: 'message_end' });
    }

    // Session persistence — the JSONL tree is the durable transcript.
    if (event.type === 'turn_start') {
      session.currentTurn = event.turnIndex;
      session.capturedThisTurn = new Set();
    } else if (event.type === 'message_end') {
      session.tree.append('assistant', {
        content: event.message.content,
        reasoning: event.message.reasoning,
        toolCalls: event.message.toolCalls,
        stopReason: event.message.stopReason,
        errorMessage: event.message.errorMessage,
        usage: event.message.usage ?? undefined
      });
      if (event.message.usage) {
        emitUsage(session, event.message.usage);
      }
    } else if (event.type === 'tool_end') {
      session.tree.append('tool_result', {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        content: String(event.result ?? ''),
        isError: event.isError
      });
    } else if (event.type === 'turn_end') {
      if (session.checkpointsEnabled && session.checkpoints && session.capturedThisTurn.size) {
        void session.checkpoints
          .finalizeTurn(session.projectRoot, event.turnIndex)
          .then((files) => {
            emit(session, {
              type: 'checkpoint_finalized',
              chatId: session.chatId,
              turnIndex: event.turnIndex,
              files: files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions, kind: f.kind }))
            });
          })
          .catch(() => {});
      }
      session.currentTurn = 0;
    }
  });
}

// ── Session lifecycle ──────────────────────────────────────────────────

function agentePaths(): { sessionsDir: string; checkpointsDir: string } {
  const { appData } = getAppPaths();
  return {
    sessionsDir: path.join(appData, 'agente', 'sessions'),
    checkpointsDir: path.join(appData, 'agente', 'checkpoints')
  };
}

async function findSessionFile(sessionsDir: string, projectRoot: string, sessionId: string): Promise<string | null> {
  const dir = path.join(sessionsDir, projectSlug(projectRoot));
  const { readdir } = await import('node:fs/promises');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const match = names.find((name) => name.endsWith(`-${sessionId}.jsonl`));
  return match ? path.join(dir, match) : null;
}

export async function startSession(args: AgenteStartSessionArgs): Promise<{ sessionId: string; resumed: boolean }> {
  closeSessionInternal(args.chatId);

  const { sessionsDir, checkpointsDir } = agentePaths();
  const transport = resolveTransport(args.provider, args.model, args.thinkingLevel);

  let tree: SessionTree;
  let resumed = false;
  if (args.resumeSessionId) {
    const file = await findSessionFile(sessionsDir, args.projectRoot, args.resumeSessionId);
    if (file) {
      tree = await SessionTree.open(file);
      resumed = true;
    } else {
      tree = SessionTree.create(args.projectRoot, sessionsDir, args.resumeSessionId);
    }
  } else {
    tree = SessionTree.create(args.projectRoot, sessionsDir);
  }

  const registry = new ToolRegistry();
  for (const tool of createBuiltinTools(args.projectRoot)) registry.register(tool);

  // Extensions: built-ins (and later, externally loaded ones) filtered by
  // the user's config toggles. They register through the same public API a
  // third-party extension would use.
  const extensionRunner = new ExtensionRunner(
    {
      projectRoot: args.projectRoot,
      sessionId: tree.header.id,
      runtimeMode: args.runtimeMode,
      appendEntry: (type, data) => tree.append('custom', { extension: type, data })
    },
    (extensionId, error) => console.warn(`[agente] extension ${extensionId} error: ${error}`)
  );
  await extensionRunner.load(enabledExtensions());
  for (const tool of extensionRunner.tools) registry.register(tool);

  // Assigned right after construction; listeners need the session object.
  const session: RuntimeSession = {
    chatId: args.chatId,
    projectRoot: args.projectRoot,
    sessionId: tree.header.id,
    registry,
    tree,
    checkpointsEnabled: args.checkpointsEnabled !== false,
    checkpoints: null,
    transport,
    runtimeMode: args.runtimeMode,
    systemPrompt: args.systemPromptOverride || buildAgenteSystemPrompt(args.projectRoot),
    extensions: extensionRunner,
    contextWindow: FALLBACK_CONTEXT_WINDOW,
    currentTurn: 0,
    capturedThisTurn: new Set(),
    pendingApprovals: new Map(),
    disposed: false,
    agent: undefined as unknown as Agent
  };
  if (session.checkpointsEnabled) {
    session.checkpoints = new CheckpointStore(path.join(checkpointsDir, tree.header.id));
  }

  const restoredModel = tree.lastModelChange();
  if (restoredModel) {
    session.transport = resolveTransport(restoredModel.provider, restoredModel.model, restoredModel.thinkingLevel);
  }

  // The context hook lets extensions rewrite the message list on every LLM
  // call (pi's transformContext choke point).
  const baseStreamFn = createProviderStreamFn(session.transport);

  const agent = new Agent({
    systemPrompt: session.systemPrompt,
    tools: registry.asMap() as Map<string, AgentTool>,
    enabledTools: registry.enabledNames(),
    streamFn: async (request) => {
      const messages = await extensionRunner.applyContextHooks(request.messages);
      return baseStreamFn({ ...request, messages });
    },
    maxTurns: DEFAULT_MAX_TURNS,
    hooks: buildHooks(session)
  });
  if (resumed) {
    agent.messages = tree.buildContext();
    if (agent.messages.length) {
      // Session tree write-ahead: the header exists on disk only after the
      // first append, so force it now for resumed sessions too.
      tree.append('custom', { note: 'session_resumed', at: Date.now() });
    }
  }
  session.agent = agent;
  attachAgentListeners(session);
  sessions.set(args.chatId, session);

  // Best-effort context window for the usage ring; refreshed on model change.
  void resolveContextWindow(session.transport).then((contextWindow) => {
    if (session.disposed) return;
    session.contextWindow = contextWindow;
    // A resumed session already has a footprint — surface it immediately.
    const lastUsage = lastPersistedUsage(tree);
    if (lastUsage) emitUsage(session, lastUsage);
  });

  return { sessionId: tree.header.id, resumed };
}

function requireSession(chatId: string): RuntimeSession | null {
  const session = sessions.get(chatId);
  if (!session || session.disposed) return null;
  return session;
}

function closeSessionInternal(chatId: string): void {
  const session = sessions.get(chatId);
  if (!session) return;
  session.disposed = true;
  session.agent.abort();
  for (const resolve of session.pendingApprovals.values()) resolve('deny');
  session.pendingApprovals.clear();
  sessions.delete(chatId);
}

export async function closeSession(chatId: string): Promise<void> {
  closeSessionInternal(chatId);
}

export function disposeAllSessions(): void {
  for (const chatId of Array.from(sessions.keys())) closeSessionInternal(chatId);
}

// ── Commands ───────────────────────────────────────────────────────────

export async function prompt(chatId: string, text: string, images?: Array<{ data: string; mimeType: string }>): Promise<{ ok: boolean; error?: string }> {
  const session = requireSession(chatId);
  if (!session) return { ok: false, error: 'No active agente session for this chat' };
  session.tree.append('user', { content: text, images });
  await session.extensions.dispatch({ event: 'before_agent_start' });
  // Fire-and-forget: events stream back over code_agent_event.
  void session.agent.prompt({ role: 'user', content: text, images, ts: Date.now() }).catch((err: unknown) => {
    emit(session, { type: 'error', chatId, message: err instanceof Error ? err.message : String(err) });
  });
  return { ok: true };
}

export function steer(chatId: string, text: string): { ok: boolean } {
  const session = requireSession(chatId);
  if (!session) return { ok: false };
  session.agent.steer(text);
  return { ok: true };
}

export function followUp(chatId: string, text: string): { ok: boolean } {
  const session = requireSession(chatId);
  if (!session) return { ok: false };
  session.agent.followUp(text);
  return { ok: true };
}

export function abort(chatId: string): { ok: boolean } {
  const session = requireSession(chatId);
  if (!session) return { ok: false };
  session.agent.abort();
  return { ok: true };
}

export function respondApproval(chatId: string, requestId: string, decision: 'allow' | 'deny'): { ok: boolean } {
  const session = requireSession(chatId);
  if (!session) return { ok: false };
  const resolve = session.pendingApprovals.get(requestId);
  if (!resolve) return { ok: false };
  resolve(decision);
  return { ok: true };
}

export function setRuntimeMode(chatId: string, mode: 'full' | 'supervised'): { ok: boolean } {
  const session = requireSession(chatId);
  if (!session) return { ok: false };
  session.runtimeMode = mode;
  return { ok: true };
}

export function setModel(chatId: string, provider: string, model: string, thinkingLevel?: string): { ok: boolean } {
  const session = requireSession(chatId);
  if (!session) return { ok: false };
  session.transport = resolveTransport(provider, model, thinkingLevel);
  // New model → new context window for the ring.
  void resolveContextWindow(session.transport).then((contextWindow) => {
    if (!session.disposed) session.contextWindow = contextWindow;
  });
  const baseStreamFn = createProviderStreamFn(session.transport);
  (session.agent.options as { streamFn: unknown }).streamFn = async (request: Parameters<StreamFn>[0]) => {
    const messages = await session.extensions.applyContextHooks(request.messages);
    return baseStreamFn({ ...request, messages });
  };
  session.tree.append('model_change', { provider, model, thinkingLevel });
  return { ok: true };
}

export async function compact(chatId: string, customInstructions?: string): Promise<{ ok: boolean; error?: string }> {
  const session = requireSession(chatId);
  if (!session) return { ok: false, error: 'No active session' };

  emit(session, { type: 'compaction_start', chatId, reason: 'manual' });
  try {
    const transcript = session.agent.messages
      .map((message) => {
        if (message.role === 'user') return `User: ${message.content}`;
        if (message.role === 'assistant') return `Assistant: ${message.content || `(${message.toolCalls?.length ?? 0} tool calls)`}`;
        return `Tool ${message.toolName}: ${message.content.slice(0, 200)}`;
      })
      .join('\n\n');

    const summarize: Agent = new Agent({
      systemPrompt:
        'Summarize the coding session below for continuation. Keep: the goal, decisions made, files touched, current state, and open next steps. Be dense and factual.' +
        (customInstructions ? `\nExtra instructions: ${customInstructions}` : ''),
      tools: new Map(),
      enabledTools: new Set(),
      streamFn: createProviderStreamFn(session.transport),
      maxTurns: 1
    });
    await summarize.prompt({ role: 'user', content: transcript.slice(0, 100_000), ts: Date.now() });
    const lastAssistant = [...summarize.messages].reverse().find((m) => m.role === 'assistant');
    const summary = lastAssistant && lastAssistant.role === 'assistant' ? lastAssistant.content : '';

    if (!summary.trim()) throw new Error('Compaction produced an empty summary');

    session.tree.append('compaction', { summary });
    session.agent.messages = session.tree.buildContext();
    emit(session, { type: 'compaction_end', chatId, reason: 'manual', success: true });
    return { ok: true };
  } catch (err: unknown) {
    emit(session, { type: 'compaction_end', chatId, reason: 'manual', success: false });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function listCheckpoints(chatId: string): Promise<CheckpointSummary[]> {
  const session = requireSession(chatId);
  if (!session?.checkpoints) return [];
  return session.checkpoints.listTurns();
}

export async function rollback(chatId: string, turnIndex: number): Promise<{ ok: boolean; restored?: number; error?: string }> {
  const session = requireSession(chatId);
  if (!session?.checkpoints) return { ok: false, error: 'Checkpoints are disabled for this session' };
  try {
    const restored = await session.checkpoints.restore(session.projectRoot, turnIndex);
    return { ok: true, restored };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function listSessions(projectRoot: string): Promise<AgenteSessionInfo[]> {
  const { sessionsDir } = agentePaths();
  const dir = path.join(sessionsDir, projectSlug(projectRoot));
  const { readdir } = await import('node:fs/promises');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const infos: AgenteSessionInfo[] = [];
  for (const name of names.filter((n) => n.endsWith('.jsonl')).sort().reverse()) {
    try {
      const tree = await SessionTree.open(path.join(dir, name));
      const entries = tree.listEntries();
      const firstUser = entries.find((e) => e.kind === 'user');
      infos.push({
        sessionId: tree.header.id,
        projectRoot,
        createdAt: tree.header.createdAt,
        updatedAt: entries.length ? entries[entries.length - 1]!.ts : tree.header.createdAt,
        entryCount: entries.length,
        title: firstUser
          ? String((firstUser.data as { content?: string } | null)?.content ?? '').slice(0, 80) || 'Session'
          : 'Session'
      });
    } catch {
      // unreadable session file — skip
    }
  }
  return infos;
}

export function getSessionStatus(chatId: string): { active: boolean; sessionId?: string; busy?: boolean; runtimeMode?: string } {
  const session = sessions.get(chatId);
  if (!session) return { active: false };
  return { active: true, sessionId: session.sessionId, busy: session.agent.busy, runtimeMode: session.runtimeMode };
}

/** Fresh session for the same chat/project/model — keeps the old file on disk. */
export async function newSession(chatId: string): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  const session = requireSession(chatId);
  if (!session) return { ok: false, error: 'No active session' };
  const { providerName, model } = session.transport;
  const runtimeMode = session.runtimeMode;
  const projectRoot = session.projectRoot;
  closeSessionInternal(chatId);
  const result = await startSession({ chatId, projectRoot, provider: providerName, model, runtimeMode });
  return { ok: true, sessionId: result.sessionId };
}

/** Model cycling needs a model list in main; not wired yet. */
export function cycleModel(): { ok: boolean } {
  return { ok: false };
}

// ── Extension management (config-backed toggles) ───────────────────────

interface AgenteConfigSection {
  extensions?: Record<string, boolean>;
}

function extensionToggles(): Record<string, boolean> {
  const cfg = loadConfigFromDisk() as { agente?: AgenteConfigSection };
  return cfg.agente?.extensions ?? {};
}

/** Built-in extensions the user has not disabled (defaultEnabled wins when unset). */
export function enabledExtensions(): AgenteExtensionDefinition[] {
  const toggles = extensionToggles();
  return createBuiltinExtensions().filter((definition) => {
    const setting = toggles[definition.id];
    return setting === undefined ? (definition.defaultEnabled ?? true) : setting;
  });
}

export function listExtensions(): Array<{ id: string; name: string; description: string; icon?: string; enabled: boolean; defaultEnabled: boolean }> {
  const toggles = extensionToggles();
  return createBuiltinExtensions().map((definition) => ({
    id: definition.id,
    name: definition.name,
    description: definition.description,
    icon: definition.icon,
    enabled: toggles[definition.id] === undefined ? (definition.defaultEnabled ?? true) : toggles[definition.id]!,
    defaultEnabled: definition.defaultEnabled ?? true
  }));
}

export async function setExtensionEnabled(extensionId: string, enabled: boolean): Promise<{ ok: boolean }> {
  const known = createBuiltinExtensions().some((definition) => definition.id === extensionId);
  if (!known) return { ok: false };
  const cfg = loadConfigFromDisk() as { agente?: AgenteConfigSection };
  const section = { ...(cfg.agente ?? {}), extensions: { ...(cfg.agente?.extensions ?? {}), [extensionId]: enabled } };
  await updateConfig({ agente: section } as never);
  return { ok: true };
}

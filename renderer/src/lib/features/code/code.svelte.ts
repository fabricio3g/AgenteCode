import { appStore } from '$lib/stores/app.svelte';
import { approvalsStore } from '$lib/stores/approvals.svelte';
import {
  loadCodeProjectsFromDb,
  saveCodeProjectToDb,
  deleteCodeProjectFromDb,
  loadAppConfig
} from '$lib/utils/storage';
import { invoke } from '$lib/services/bridge';
import { createId } from '$lib/utils/id';
import { isDefaultChatTitle } from '$lib/stores/app-store-helpers';
import type { ChatSession, CodeProject } from '$lib/types/chat';
import type { AgenteCheckpointSummary, CodeAgentEvent } from '$shared/agente-protocol';
import { applyCodeAgentEvent, createCodeRunState, type CodeRunState } from './code-run';
import {
  startCodeAgentSession,
  promptCodeAgent,
  steerCodeAgent,
  followUpCodeAgent,
  abortCodeAgent,
  compactCodeAgent,
  setCodeAgentRuntimeMode,
  respondToCodeAgentApproval,
  listCodeAgentCheckpoints
} from './code-ipc';
import { subscribeToCodeAgentEvents } from './code-events.svelte';

interface AgenteRun extends CodeRunState {
  chatId: string;
  running: boolean;
  checkpoints: AgenteCheckpointSummary[];
  /**
   * Input handed to the engine but not yet consumed by a turn (steers and
   * follow-ups). Approximate — the engine drains asynchronously — but it
   * answers "did my message land?" while the run is live.
   */
  queuedCount: number;
}

/**
 * Code space store.
 *
 * Owns everything specific to the Code tab's agent experience: the project
 * list, folder expansion, and the live run state per conversation. Chat
 * storage stays in AppStore (chats ARE the persistence substrate) — this
 * store only reads `appStore.chats` and appends messages through small,
 * explicit mutations, so no agent state leaks back into AppStore.
 *
 * Turn contract (pi-style): a running agent is steered, never restarted.
 * `send()` starts a run or steers; `followUp()` queues for when it would
 * stop. Every user-visible input lands in the transcript.
 */
class CodeStore {
  projects = $state<CodeProject[]>([]);
  loading = $state(false);
  loaded = $state(false);
  /** Project folders expanded in the sidebar tree. */
  expandedProjects = $state<Record<string, boolean>>({});
  activeProjectId = $state<string | null>(null);

  /** Live runs keyed by chatId. */
  runs = $state<Record<string, AgenteRun>>({});
  /** engine session id per chat (also mirrored into chat.codeAgent.sessionId) */
  #sessionIds = new Map<string, string>();
  #unsubEvents: (() => void) | null = null;

  constructor() {
    // Deleted conversations must not leave run state behind (unbounded growth)
    // nor a live engine session pointing at a chat that no longer exists.
    appStore.onChatDeleted((chatId) => {
      if (this.runs[chatId]?.running) void abortCodeAgent(chatId).catch(() => {});
      this.evictChat(chatId, { force: true });
    });
  }

  async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      this.projects = await loadCodeProjectsFromDb();
      this.loaded = true;
    } finally {
      this.loading = false;
    }
  }

  async addProject(): Promise<CodeProject | null> {
    const rootPath = (await invoke<string | null>('pick_workspace_folder')) || null;
    if (!rootPath) return null;
    const segments = rootPath.split(/[\\/]/).filter(Boolean);
    const project: CodeProject = {
      id: createId('proj'),
      rootPath,
      rootName: segments[segments.length - 1] || rootPath,
      icon: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    await saveCodeProjectToDb(project);
    await this.load();
    this.activeProjectId = project.id;
    this.expandedProjects[project.id] = true;
    return project;
  }

  async removeProject(projectId: string): Promise<void> {
    await deleteCodeProjectFromDb(projectId);
    await this.load();
    if (this.activeProjectId === projectId) this.activeProjectId = null;
    // Conversations of a removed project leave the Code tree, so their cached
    // runs are unreachable — drop the idle ones (live runs finish streaming).
    for (const chat of appStore.chats) {
      if (chat.projectId === projectId) this.evictChat(chat.id);
    }
  }

  toggleExpanded(projectId: string): void {
    this.expandedProjects[projectId] = !this.expandedProjects[projectId];
  }

  projectById(projectId: string | null): CodeProject | null {
    if (!projectId) return null;
    return this.projects.find((p) => p.id === projectId) ?? null;
  }

  /** Conversations linked to a project, newest activity first. Code space only. */
  sessionsFor(projectId: string): ChatSession[] {
    return appStore.visibleCodeChats
      .filter((chat) => chat.projectId === projectId)
      .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  }

  /**
   * Create a fresh code conversation inside a project. The chat is a normal
   * code-space session tagged with the project and the agente driver meta the
   * engine attaches to when it starts.
   *
   * The projectId/codeAgent writes MUST go through the reactive proxy from
   * `appStore.chats` — createChat() returns the raw pre-proxy object, and a
   * raw-target write never notifies subscribers, leaving the sidebar tree
   * and the surface blind to the new conversation.
   */
  newConversation(project: CodeProject): ChatSession {
    const created = appStore.createChat('code');
    const chat = appStore.chats.find((c) => c.id === created.id);
    if (!chat) return created;
    chat.projectId = project.id;
    chat.codeAgent = {
      instanceId: 'agente',
      driverKind: 'agente',
      substrate: 'native',
      runtimeMode: 'supervised',
      updatedAt: Date.now()
    };
    this.activeProjectId = project.id;
    this.expandedProjects[project.id] = true;
    appStore.persist();
    return chat;
  }

  openConversation(chatId: string): void {
    const chat = appStore.chats.find((c) => c.id === chatId);
    if (chat?.projectId) this.activeProjectId = chat.projectId;
    appStore.selectChat(chatId);
  }

  // ── Model readiness ─────────────────────────────────────────────────

  /**
   * True when the current app-wide model selection can actually run. Mirrors
   * Home's composer guard so both spaces refuse to send into a void: local
   * needs a loaded model, API needs a key AND a model id.
   */
  get modelReady(): boolean {
    if (appStore.backendMode === 'local') {
      return !!(appStore.selectedLocalModelPath && appStore.localModelActive);
    }
    const provider = appStore.activeProvider;
    return !!(provider && (provider.has_api_key || provider.api_key) && provider.model);
  }

  /** Resolve provider/model from app config the same way the chat pipeline does. */
  async #resolveProviderModel(): Promise<{ provider: string; model: string }> {
    const config = await loadAppConfig();
    if (config.llm?.backend_mode === 'local' || !config.llm?.provider) {
      return { provider: 'local', model: config.llm?.local?.model || '' };
    }
    const name = config.llm.provider;
    const entry = config.llm.providers?.[name];
    return { provider: name, model: entry?.model || '' };
  }

  // ── Live runs ────────────────────────────────────────────────────────

  runFor(chatId: string | null | undefined): AgenteRun | null {
    if (!chatId) return null;
    return this.runs[chatId] ?? null;
  }

  /**
   * Drop cached run/session state for a chat. Live runs are kept unless
   * `force` is set — chat deletion aborts the engine first, and the late
   * `agent_end` of a deleted chat must not re-materialize its run.
   */
  evictChat(chatId: string, options: { force?: boolean } = {}): void {
    if (!options.force && this.runs[chatId]?.running) return;
    if (this.runs[chatId]) {
      const next = { ...this.runs };
      delete next[chatId];
      this.runs = next;
    }
    this.#sessionIds.delete(chatId);
  }

  /** True once an engine session has been started for this chat. */
  hasSession(chatId: string): boolean {
    return this.#sessionIds.has(chatId);
  }

  #requireRun(chatId: string): AgenteRun {
    if (!this.runs[chatId]) {
      this.runs[chatId] = { chatId, running: false, checkpoints: [], queuedCount: 0, ...createCodeRunState() };
    }
    return this.runs[chatId]!;
  }

  #ensureEventSubscription(): void {
    if (this.#unsubEvents) return;
    this.#unsubEvents = subscribeToCodeAgentEvents('*', (event) => this.#handleEvent(event));
  }

  #handleEvent(event: CodeAgentEvent): void {
    let run = this.runs[event.chatId];
    if (!run) {
      // Post-reload or out-of-order pushes used to vanish when the run map had
      // not been populated yet. Materialize a run for chats we know about so
      // deltas have somewhere to land; ignore events for unknown chats.
      if (!appStore.chats.some((chat) => chat.id === event.chatId)) return;
      run = this.#requireRun(event.chatId);
    }

    applyCodeAgentEvent(run, event);
    if (event.type === 'agent_start') {
      run.running = true;
      run.queuedCount = 0;
    }
    if (run.done) run.running = false;
    if (event.type === 'agent_end') {
      run.queuedCount = 0;
      void this.refreshCheckpoints(event.chatId);
    }
    this.#flushToMessage(event.chatId, run);

    if (event.type === 'approval_request') {
      void (async () => {
        const isPlan = event.kind === 'plan';
        // Resolve cwd from the event's own chat — the sidebar's active
        // project may belong to a different conversation.
        const chat = appStore.chats.find((c) => c.id === event.chatId);
        const project = this.projectById(chat?.projectId ?? null);
        const allow = await approvalsStore.request({
          id: event.requestId,
          chatId: event.chatId,
          command: isPlan
            ? `Approve plan — ${summarizeArgs(event.args) || event.toolName}`
            : `${event.toolName} ${summarizeArgs(event.args)}`.trim(),
          cwd: project?.rootPath || 'project'
        });
        await respondToCodeAgentApproval(event.chatId, event.requestId, allow ? 'allow' : 'deny').catch(() => {});
      })();
    }
  }

  /** Mirror run state into the streaming assistant message of the chat. */
  #flushToMessage(chatId: string, run: AgenteRun): void {
    const chat = appStore.chats.find((c) => c.id === chatId);
    if (!chat) return;
    let message = chat.messages.at(-1);
    if (!message || message.role !== 'assistant' || message.status !== 'streaming') return;
    message.content = run.content;
    message.reasoning = run.reasoning || undefined;
    message.agentSteps = run.steps.map((step) => ({ ...step }));
    if (run.done) {
      message.status = run.error ? 'error' : 'idle';
      message.done = true;
      // The reason belongs on the message — the transcript renders it, not
      // just a generic "failed" card.
      if (run.error) {
        message.metadata = { ...message.metadata, error: true, errorMessage: run.error };
        if (!message.content) message.content = run.error;
      } else if (run.stopReason) {
        message.metadata = { ...message.metadata, codeStopReason: run.stopReason };
      }
      appStore.markChatDirty(chatId);
      appStore.persist();
    }
  }

  /** Append a user message to a chat transcript (no assistant placeholder). */
  #appendUserTurn(chat: ChatSession, text: string): void {
    chat.messages.push({
      id: createId('msg'),
      role: 'user',
      content: text,
      createdAt: Date.now()
    });
    if (isDefaultChatTitle(chat.title)) {
      chat.title = text.slice(0, 60);
    }
    chat.updatedAt = Date.now();
    appStore.markChatDirty(chat.id);
    appStore.persist();
  }

  /** Push the user turn plus the streaming assistant placeholder for a run. */
  #appendTurnPair(chat: ChatSession, text: string): void {
    this.#appendUserTurn(chat, text);
    chat.messages.push({
      id: createId('msg'),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      status: 'streaming',
      mode: 'agent',
      agentSteps: []
    });
    appStore.markChatDirty(chat.id);
    appStore.persist();
  }

  /** Mark the streaming assistant message as failed with a visible reason. */
  #failStreamingMessage(chatId: string, error: string): void {
    const chat = appStore.chats.find((c) => c.id === chatId);
    const message = chat?.messages.at(-1);
    if (!chat || !message || message.role !== 'assistant' || message.status !== 'streaming') return;
    message.status = 'error';
    message.done = true;
    message.metadata = { ...message.metadata, error: true, errorMessage: error };
    if (!message.content) message.content = error;
    appStore.markChatDirty(chatId);
    appStore.persist();
  }

  /**
   * Start (or resume) the engine session for a chat and send the prompt.
   * While a run is active the prompt becomes a steer — course correction,
   * recorded in the transcript like any other user turn.
   * The assistant placeholder message streams live from code_agent_event.
   */
  async send(chatId: string, text: string): Promise<void> {
    const chat = appStore.chats.find((c) => c.id === chatId);
    const project = this.projectById(chat?.projectId ?? null);
    if (!chat || !project || !text.trim()) return;

    const run = this.#requireRun(chatId);
    if (run.running) {
      await this.steer(chatId, text);
      return;
    }

    // Keep the last usage report visible between runs — the next turn
    // refreshes it; it should not blank while the first reply streams.
    const previousUsage = run.usage;
    Object.assign(run, createCodeRunState(), { running: true, checkpoints: run.checkpoints, usage: previousUsage });
    this.#ensureEventSubscription();

    if (!this.#sessionIds.has(chatId)) {
      try {
        const { provider, model } = await this.#resolveProviderModel();
        if (!model) {
          throw new Error('No model selected — pick one in the Model Hub first.');
        }
        const runtimeMode = chat.codeAgent?.runtimeMode || 'supervised';
        const resumeSessionId = chat.codeAgent?.sessionId || undefined;
        const { sessionId } = await startCodeAgentSession({
          chatId,
          projectRoot: project.rootPath,
          provider,
          model,
          runtimeMode,
          resumeSessionId
        });
        this.#sessionIds.set(chatId, sessionId);
        if (chat.codeAgent) {
          chat.codeAgent.sessionId = sessionId;
          chat.codeAgent.updatedAt = Date.now();
        }
      } catch (err: unknown) {
        const messageText = err instanceof Error ? err.message : String(err);
        run.running = false;
        run.done = true;
        run.error = messageText;
        // A failed start is still a turn: show what was asked and why it
        // failed instead of swallowing both.
        this.#appendTurnPair(chat, text);
        this.#failStreamingMessage(chatId, messageText);
        return;
      }
    }

    this.#appendTurnPair(chat, text);

    const result = await promptCodeAgent(chatId, text);
    if (!result.ok) {
      run.error = result.error || 'Failed to start the coding agent.';
      run.running = false;
      run.done = true;
      this.#failStreamingMessage(chatId, run.error);
      this.#flushToMessage(chatId, run);
    }
  }

  /**
   * Course-correct mid-run: records the message in the transcript and hands
   * it to the engine, which injects it after the current tool batch.
   */
  async steer(chatId: string, text: string): Promise<void> {
    const chat = appStore.chats.find((c) => c.id === chatId);
    if (!chat || !text.trim()) return;
    this.#appendUserTurn(chat, text);
    const run = this.#requireRun(chatId);
    run.queuedCount += 1;
    try {
      const result = await steerCodeAgent(chatId, text);
      if (!result.ok) this.#rollbackQueued(run);
    } catch {
      this.#rollbackQueued(run);
    }
  }

  /** Queue input that runs only when the agent would otherwise stop. */
  async followUp(chatId: string, text: string): Promise<void> {
    const chat = appStore.chats.find((c) => c.id === chatId);
    if (!chat || !text.trim()) return;
    const run = this.#requireRun(chatId);
    if (!run.running) {
      await this.send(chatId, text);
      return;
    }
    this.#appendUserTurn(chat, text);
    run.queuedCount += 1;
    try {
      const result = await followUpCodeAgent(chatId, text);
      if (!result.ok) this.#rollbackQueued(run);
    } catch {
      this.#rollbackQueued(run);
    }
  }

  /** Undo a queued-count bump when the engine never accepted the input. */
  #rollbackQueued(run: AgenteRun): void {
    run.queuedCount = Math.max(0, run.queuedCount - 1);
  }

  async stop(chatId: string): Promise<void> {
    await abortCodeAgent(chatId);
  }

  async setMode(chatId: string, mode: 'full' | 'supervised' | 'plan'): Promise<void> {
    const chat = appStore.chats.find((c) => c.id === chatId);
    if (chat?.codeAgent) {
      chat.codeAgent.runtimeMode = mode;
      chat.codeAgent.updatedAt = Date.now();
    }
    await setCodeAgentRuntimeMode(chatId, mode);
  }

  async compact(chatId: string): Promise<{ ok: boolean; error?: string }> {
    return compactCodeAgent(chatId);
  }

  async refreshCheckpoints(chatId: string): Promise<void> {
    const run = this.#requireRun(chatId);
    run.checkpoints = await listCodeAgentCheckpoints(chatId).catch(() => []);
  }
}

function summarizeArgs(args: unknown): string {
  if (args && typeof args === 'object') {
    const record = args as Record<string, unknown>;
    if (typeof record.command === 'string') return record.command;
    if (typeof record.path === 'string') return record.path;
  }
  return '';
}

export const codeStore = new CodeStore();

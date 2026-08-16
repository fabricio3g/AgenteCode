import { appStore } from '$lib/stores/app.svelte';
import { approvalsStore } from '$lib/stores/approvals.svelte';
import {
  loadCodeProjectsFromDb,
  saveCodeProjectToDb,
  deleteCodeProjectFromDb,
  loadAppConfig
} from '$lib/utils/storage';
import { invoke } from '$lib/services/tauri';
import { createId } from '$lib/utils/id';
import type { ChatSession, CodeProject } from '$lib/types/chat';
import type { AgenteCheckpointSummary, CodeAgentEvent } from './agente-protocol';
import { applyCodeAgentEvent, createAgenteRunState, type AgenteRunState } from './agente-run';
import {
  startAgenteSession,
  promptAgente,
  steerAgente,
  abortAgente,
  compactAgente,
  setAgenteRuntimeMode,
  respondToAgenteApproval,
  listAgenteCheckpoints
} from './agente-ipc';
import { subscribeToCodeAgentEvents } from './agente-events.svelte';

interface AgenteRun extends AgenteRunState {
  chatId: string;
  running: boolean;
  checkpoints: AgenteCheckpointSummary[];
}

/**
 * Agente Coding store.
 *
 * Owns everything specific to the Code tab's agent experience: the project
 * list, folder expansion, and the live run state per conversation. Chat
 * storage stays in AppStore (chats ARE the persistence substrate) — this
 * store only reads `appStore.chats` and appends messages through small,
 * explicit mutations, so no agent state leaks back into AppStore.
 */
class AgenteStore {
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
  #modelLabel = $state('');
  #unsubEvents: (() => void) | null = null;

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
  }

  toggleExpanded(projectId: string): void {
    this.expandedProjects[projectId] = !this.expandedProjects[projectId];
  }

  projectById(projectId: string | null): CodeProject | null {
    if (!projectId) return null;
    return this.projects.find((p) => p.id === projectId) ?? null;
  }

  /** Conversations linked to a project, newest activity first. */
  sessionsFor(projectId: string): ChatSession[] {
    return appStore.chats
      .filter((chat) => chat.projectId === projectId)
      .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  }

  /**
   * Create a fresh agente conversation inside a project. The chat is a normal
   * work-space session tagged with the project and the agente driver meta the
   * engine attaches to when it starts.
   *
   * The projectId/codeAgent writes MUST go through the reactive proxy from
   * `appStore.chats` — createChat() returns the raw pre-proxy object, and a
   * raw-target write never notifies subscribers, leaving the sidebar tree
   * and the surface blind to the new conversation.
   */
  newConversation(project: CodeProject): ChatSession {
    const created = appStore.createChat('work');
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

  // ── Live runs ────────────────────────────────────────────────────────

  runFor(chatId: string | null | undefined): AgenteRun | null {
    if (!chatId) return null;
    return this.runs[chatId] ?? null;
  }

  /** True once an engine session has been started for this chat. */
  hasSession(chatId: string): boolean {
    return this.#sessionIds.has(chatId);
  }

  get modelLabel(): string {
    return this.#modelLabel;
  }

  #requireRun(chatId: string): AgenteRun {
    if (!this.runs[chatId]) {
      this.runs[chatId] = { chatId, running: false, checkpoints: [], ...createAgenteRunState() };
    }
    return this.runs[chatId]!;
  }

  /** Resolve provider/model from app config the same way the chat pipeline does. */
  async #resolveProviderModel(): Promise<{ provider: string; model: string }> {
    const config = await loadAppConfig();
    if (config.llm?.backend_mode === 'local' || !config.llm?.provider) {
      return { provider: 'local', model: config.llm?.local?.model || 'local-model' };
    }
    const name = config.llm.provider;
    const entry = config.llm.providers?.[name];
    return { provider: name, model: entry?.model || '' };
  }

  #ensureEventSubscription(): void {
    if (this.#unsubEvents) return;
    this.#unsubEvents = subscribeToCodeAgentEvents('*', (event) => this.#handleEvent(event));
  }

  #handleEvent(event: CodeAgentEvent): void {
    const run = this.runs[event.chatId];
    if (run) {
      applyCodeAgentEvent(run, event);
      if (event.type === 'agent_end') {
        run.running = false;
        void this.refreshCheckpoints(event.chatId);
      }
      this.#flushToMessage(event.chatId, run);
    }

    if (event.type === 'approval_request') {
      void (async () => {
        const isPlan = event.kind === 'plan';
        const allow = await approvalsStore.request({
          id: event.requestId,
          chatId: event.chatId,
          command: isPlan
            ? `Approve plan — ${summarizeArgs(event.args) || event.toolName}`
            : `${event.toolName} ${summarizeArgs(event.args)}`.trim(),
          cwd: this.projectById(this.activeProjectId)?.rootPath || 'project'
        });
        await respondToAgenteApproval(event.chatId, event.requestId, allow ? 'allow' : 'deny').catch(() => {});
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
      appStore.markChatDirty(chatId);
      appStore.persist();
    }
  }

  /**
   * Start (or resume) the engine session for a chat and send the prompt.
   * The assistant placeholder message streams live from code_agent_event.
   */
  async send(chatId: string, text: string): Promise<void> {
    const chat = appStore.chats.find((c) => c.id === chatId);
    const project = this.projectById(chat?.projectId ?? null);
    if (!chat || !project || !text.trim()) return;

    const run = this.#requireRun(chatId);
    if (run.running) {
      await steerAgente(chatId, text);
      return;
    }

    // Keep the last usage report visible between runs — the next turn
    // refreshes it; it should not blank while the first reply streams.
    const previousUsage = run.usage;
    Object.assign(run, createAgenteRunState(), { running: true, checkpoints: run.checkpoints, usage: previousUsage });
    this.#ensureEventSubscription();

    if (!this.#sessionIds.has(chatId)) {
      try {
        const { provider, model } = await this.#resolveProviderModel();
        this.#modelLabel = `${provider}:${model}`;
        const runtimeMode = chat.codeAgent?.runtimeMode || 'supervised';
        const resumeSessionId = chat.codeAgent?.sessionId || undefined;
        const { sessionId } = await startAgenteSession({
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
        run.running = false;
        run.done = true;
        run.error = err instanceof Error ? err.message : String(err);
        return;
      }
    }

    chat.messages.push({
      id: createId('msg'),
      role: 'user',
      content: text,
      createdAt: Date.now()
    });
    chat.messages.push({
      id: createId('msg'),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      status: 'streaming',
      mode: 'agent',
      agentSteps: []
    });
    if (!chat.title || chat.title === 'New work' || chat.title === 'New chat' || chat.title === 'New conversation' || chat.title === 'New Work') {
      chat.title = text.slice(0, 60);
    }
    chat.updatedAt = Date.now();
    appStore.markChatDirty(chatId);
    appStore.persist();

    const result = await promptAgente(chatId, text);
    if (!result.ok) {
      run.error = result.error || 'Failed to start agente run';
      run.running = false;
      run.done = true;
      this.#flushToMessage(chatId, run);
    }
  }

  async stop(chatId: string): Promise<void> {
    await abortAgente(chatId);
  }

  async setMode(chatId: string, mode: 'full' | 'supervised' | 'plan'): Promise<void> {
    const chat = appStore.chats.find((c) => c.id === chatId);
    if (chat?.codeAgent) {
      chat.codeAgent.runtimeMode = mode;
      chat.codeAgent.updatedAt = Date.now();
    }
    await setAgenteRuntimeMode(chatId, mode);
  }

  async compact(chatId: string): Promise<{ ok: boolean; error?: string }> {
    return compactAgente(chatId);
  }

  async refreshCheckpoints(chatId: string): Promise<void> {
    const run = this.#requireRun(chatId);
    run.checkpoints = await listAgenteCheckpoints(chatId).catch(() => []);
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

export const agenteStore = new AgenteStore();

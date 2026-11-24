import { appStore } from '$lib/stores/app.svelte';
import { isConfigModelReady } from '$lib/stores/chat-model';
import { approvalsStore } from '$lib/stores/approvals.svelte';
import { toastStore } from '$lib/stores/toast.svelte';
import {
  loadCodeProjectsFromDb,
  saveCodeProjectToDb,
  deleteCodeProjectFromDb
} from '$lib/utils/storage';
import { get } from 'svelte/store';
import { t } from 'svelte-i18n';
import { invoke } from '$lib/services/bridge';
import { currentProviderModel } from '$lib/services/current-model';
import { pathExists, pickWorkspaceFolder } from '$lib/services/files';
import { createId } from '$lib/utils/id';
import { isDefaultChatTitle } from '$lib/stores/app-store-helpers';
import type { ChatSession, CodeProject, CodeTimelineEntry } from '$lib/types/chat';
import type { AgenteCheckpointSummary, CodeAgentEvent } from '$shared/agente-protocol';
import { applyCodeAgentEvent, codeRunElapsed, conversationTodos, createCodeRunState, type CodeRunState } from './code-run';
import {
  startCodeAgentSession,
  promptCodeAgent,
  steerCodeAgent,
  followUpCodeAgent,
  abortCodeAgent,
  compactCodeAgent,
  setCodeAgentRuntimeMode,
  respondToCodeAgentApproval,
  listCodeAgentCheckpoints,
  rollbackCodeAgent,
  deleteCodeAgentSessionData,
  listLiveCodeAgentChats,
  setAgenteModel,
  execCodeCommand
} from './code-ipc';
import { codeMessageAction } from './code-ipc';
import type { Attachment, SessionInfo, SessionSnapshot } from '$shared/agente-protocol.gen';
import { subscribeToCodeAgentEvents } from './code-events.svelte';

interface AgenteRun extends CodeRunState {
  chatId: string;
  running: boolean;
  /** Stable transcript target; queued user inputs can follow this message. */
  assistantMessageId?: string;
  dismissedErrorMessageId?: string;
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
/** Remembers the last runtime mode picked, for new conversations. */
const DEFAULT_MODE_KEY = 'flaxeo.code.defaultMode';

class CodeStore {
  projects = $state<CodeProject[]>([]);
  loading = $state(false);
  loaded = $state(false);
  /** Project folders expanded in the sidebar tree (remembered across launches). */
  expandedProjects = $state<Record<string, boolean>>(readExpanded());
  /** Projects whose folder was not found on disk at the last check. */
  missingProjects = $state<Record<string, boolean>>({});
  activeProjectId = $state<string | null>(null);
  /** The "Add project" folder browser modal (FolderBrowserDialog, mounted once in AppShell). */
  folderBrowserOpen = $state(false);
  #folderPick: ((path: string | null) => void) | null = null;

  /** Live runs keyed by chatId. */
  runs = $state<Record<string, AgenteRun>>({});
  /** engine session id per chat (also mirrored into chat.codeAgent.sessionId) */
  #sessionIds = new Map<string, string>();
  #conversationIndices = new Map<string, number>();
  /** Approvals the engine settled itself (abort, shutdown) — do not answer them again. */
  #engineSettled = new Set<string>();
  /** The reply opened for a steer the agent just read, by chat: empty at the end means unanswered. */
  #steerReplies = new Map<string, string>();
  #repairedInterrupted = false;
  #unsubEvents: (() => void) | null = null;
  /** Chats whose streaming message waits for the next frame's flush. */
  #pendingFlush = new Map<string, () => void>();
  /** Invalidates an auto-start already scheduled when the user presses Stop. */
  #stopEpoch = new Map<string, number>();
  /** Guards against rapid double-send races while ensureChatMessages is awaiting. */
  #startingTurns = new Set<string>();

  constructor() {
    // Deleted conversations must not leave run state behind (unbounded growth)
    // nor a live engine session pointing at a chat that no longer exists.
    appStore.onChatDeleted((chatId, chat) => {
      if (this.runs[chatId]?.running) void abortCodeAgent(chatId).catch(() => {});
      this.evictChat(chatId, { force: true });
      // The engine's log and checkpoints belong to the conversation: they go
      // with it. Project files are never touched.
      if (chat?.codeAgent || chat?.projectId) {
        const sessionId = chat.codeAgent?.sessionId;
        void deleteCodeAgentSessionData({ chatIds: [chatId], sessionIds: sessionId ? [sessionId] : [] }).catch(() => {});
      }
    });
    $effect.root(() => {
      $effect(() => writeExpanded(this.expandedProjects));
    });
  }

  async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.#ensureEventSubscription();
    try {
      this.projects = sortByActivity(await loadCodeProjectsFromDb());
      this.loaded = true;
    } finally {
      this.loading = false;
    }
    void this.checkFolders();
    void this.#repairInterrupted();
  }

  /**
   * A run the app was closed in the middle of is saved as "streaming" and
   * would otherwise look live forever (and turn the next message into a
   * steer to a session that no longer exists). Runs the engine still has —
   * a renderer reload keeps them going — are left alone.
   */
  async #repairInterrupted(): Promise<void> {
    if (this.#repairedInterrupted) return;
    this.#repairedInterrupted = true;
    const live = new Set(await listLiveCodeAgentChats().catch(() => [] as string[]));
    for (const chat of appStore.visibleCodeChats) {
      if (live.has(chat.id)) { this.#requireRun(chat.id); continue; }
      const stuck = chat.messages.filter((message) => message.role === 'assistant' && message.status === 'streaming');
      if (!stuck.length) continue;
      for (const message of stuck) {
        message.status = 'idle';
        message.done = true;
        message.metadata = { ...message.metadata, codeStopReason: 'aborted', codeNote: 'interrupted' };
        for (const step of message.agentSteps ?? []) {
          if (step.status === 'running' || step.status === 'awaiting_approval') step.status = 'error';
        }
      }
      this.evictChat(chat.id, { force: true });
      appStore.markChatDirty(chat.id);
    }
    appStore.persist();
  }

  /** Flag projects whose folder moved or was deleted outside the app. */
  async checkFolders(): Promise<void> {
    const entries = await Promise.all(
      this.projects.map(async (project) => [project.id, !(await pathExists(project.rootPath).catch(() => true))] as const)
    );
    this.missingProjects = Object.fromEntries(entries.filter(([, missing]) => missing));
  }

  /**
   * Adds the given folder; with none, opens the folder browser modal and adds
   * what is picked there (its "Browse…" falls back to the system dialog).
   */
  async addProject(folder?: string): Promise<CodeProject | null> {
    const rootPath = folder || (await this.#askForFolder());
    if (!rootPath) return null;
    // The same folder twice is one project: select the one that exists.
    const existing = this.projects.find((project) => samePath(project.rootPath, rootPath));
    if (existing) {
      this.activeProjectId = existing.id;
      this.expandedProjects[existing.id] = true;
      return existing;
    }
    const project: CodeProject = {
      id: createId('proj'),
      rootPath,
      rootName: folderName(rootPath),
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

  #askForFolder(): Promise<string | null> {
    this.#folderPick?.(null);
    this.folderBrowserOpen = true;
    return new Promise((resolve) => { this.#folderPick = resolve; });
  }

  /** The folder browser's answer: a path, or null when it was closed. */
  resolveFolderBrowser(path: string | null): void {
    this.folderBrowserOpen = false;
    const pick = this.#folderPick;
    this.#folderPick = null;
    pick?.(path);
  }

  /** "Browse…" in the folder browser: the system dialog instead. */
  async pickWithSystemDialog(): Promise<void> {
    const path = (await pickWorkspaceFolder()) || null;
    if (path) this.resolveFolderBrowser(path);
  }

  /**
   * Delete a project from Agente: every conversation in it (and the engine's
   * logs and checkpoints for them), then the project itself. The folder on
   * disk is never touched.
   */
  async deleteProject(projectId: string): Promise<void> {
    const conversations = appStore.chats.filter((chat) => chat.projectId === projectId);
    for (const chat of conversations) {
      if (this.runs[chat.id]?.running) await abortCodeAgent(chat.id).catch(() => {});
      appStore.deleteChat(chat.id, { silent: true });
    }
    await deleteCodeProjectFromDb(projectId);
    if (this.activeProjectId === projectId) this.activeProjectId = null;
    delete this.expandedProjects[projectId];
    await this.load();
  }

  /** Display name only; the folder keeps its name. */
  async renameProject(projectId: string, name: string): Promise<void> {
    const project = this.projectById(projectId);
    const trimmed = name.trim();
    if (!project || !trimmed || trimmed === project.rootName) return;
    await saveCodeProjectToDb({ ...project, rootName: trimmed, updatedAt: project.updatedAt });
    await this.load();
  }

  /** Point a project whose folder moved at its new location. */
  async locateProject(projectId: string): Promise<void> {
    const project = this.projectById(projectId);
    if (!project) return;
    const rootPath = await pickWorkspaceFolder();
    if (!rootPath) return;
    await saveCodeProjectToDb({ ...project, rootPath, updatedAt: Date.now() });
    await this.load();
  }

  /** Open the project folder in the system file manager. */
  async revealProject(projectId: string): Promise<void> {
    const project = this.projectById(projectId);
    if (project) await invoke('open_workspace_file', { absolutePath: project.rootPath, workspaceRoot: project.rootPath });
  }

  /** Conversations whose project no longer exists (older builds orphaned them). */
  get unlinkedConversations(): ChatSession[] {
    if (!this.loaded) return [];
    const known = new Set(this.projects.map((project) => project.id));
    return appStore.visibleCodeChats.filter((chat) => !chat.projectId || !known.has(chat.projectId));
  }

  /** Move a project to the top of the list when something happens in it. */
  #touchProject(projectId: string | null | undefined): void {
    const project = this.projectById(projectId ?? null);
    if (!project) return;
    project.updatedAt = Date.now();
    this.projects = sortByActivity(this.projects);
    void saveCodeProjectToDb({ ...project });
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
  /**
   * The mode new conversations start in: the last one picked, full-auto
   * until then (approvals stay one click away in the composer).
   */
  get defaultMode(): 'full' | 'supervised' | 'plan' {
    try {
      const saved = localStorage.getItem(DEFAULT_MODE_KEY);
      if (saved === 'full' || saved === 'supervised' || saved === 'plan') return saved;
    } catch {
      // Blocked storage: fall through to the default.
    }
    return 'full';
  }

  newConversation(project: CodeProject): ChatSession {
    const created = appStore.createChat('code');
    const chat = appStore.chats.find((c) => c.id === created.id);
    if (!chat) return created;
    chat.projectId = project.id;
    chat.codeAgent = {
      instanceId: 'agente',
      driverKind: 'agente',
      substrate: 'native',
      runtimeMode: this.defaultMode,
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

  async importSession(info: SessionInfo): Promise<void> {
    const existing = appStore.chats.find((chat) => chat.codeAgent?.sessionId === info.session_id);
    if (existing) { this.openConversation(existing.id); return; }
    let project = this.projects.find((item) => samePath(item.rootPath, info.project_dir));
    if (!project) {
      project = { id: createId('proj'), rootPath: info.project_dir, rootName: folderName(info.project_dir), createdAt: Date.now(), updatedAt: Date.now() };
      await saveCodeProjectToDb(project);
      this.projects = sortByActivity([...this.projects, project]);
    }
    const created = this.newConversation(project);
    const chat = appStore.chats.find((item) => item.id === created.id)!;
    const turns = await invoke<Array<{ prompt: string; conversationIndex: number; events: CodeAgentEvent[] }>>('agente_session_history', { sessionId: info.session_id, chatId: chat.id });
    chat.codeAgent!.sessionId = info.session_id;
    chat.title = info.title || info.first_prompt || 'Resumed session';
    for (const turn of turns) {
      const run = createCodeRunState();
      run.todos = conversationTodos(chat.messages);
      for (const event of turn.events) applyCodeAgentEvent(run, event);
      chat.messages.push(
        { id: createId('msg'), role: 'user', content: turn.prompt, createdAt: Date.now(), metadata: { codeConversationIndex: turn.conversationIndex } },
        { id: createId('msg'), role: 'assistant', content: run.content, reasoning: run.reasoning, createdAt: Date.now(), done: true, status: 'idle', agentSteps: run.steps, metadata: { codeTimeline: run.timeline, codeTodos: run.todos, codeChildren: run.children, codeSpend: run.spend, codeUsage: run.usage, tokensPerSecond: run.tokensPerSecond, codeDiagnostics: run.diagnostics } }
      );
    }
    appStore.markChatDirty(chat.id);
    appStore.persist();
  }

  async ensureSession(chatId: string): Promise<void> {
    const chat = appStore.chats.find((item) => item.id === chatId);
    const project = this.projectById(chat?.projectId ?? null);
    if (!chat || !project) throw new Error('Select a project first.');
    const error = await this.#ensureSession(chat, project);
    if (error) throw new Error(error);
  }

  // ── Model readiness ─────────────────────────────────────────────────

  /**
   * True when the current app-wide model selection can actually run. Mirrors
   * Home's composer guard so both spaces refuse to send into a void: local
   * needs a loaded model, API needs a key AND a model id.
   */
  get modelReady(): boolean {
    return isConfigModelReady(appStore.config, appStore.localModelActive);
  }

  // ── Live runs ────────────────────────────────────────────────────────

  runFor(chatId: string | null | undefined): AgenteRun | null {
    if (!chatId) return null;
    return this.runs[chatId] ?? null;
  }

  /** The engine session a chat runs in, once it has one. */
  sessionIdFor(chatId: string): string | undefined {
    return this.#sessionIds.get(chatId) ?? (appStore.chats.find((chat) => chat.id === chatId)?.codeAgent?.sessionId || undefined);
  }

  todosFor(chat: ChatSession) {
    const run = this.runFor(chat.id);
    return run?.running ? run.todos : conversationTodos(chat.messages);
  }

  /**
   * Drop cached run/session state for a chat. Live runs are kept unless
   * `force` is set — chat deletion aborts the engine first, and the late
   * `agent_end` of a deleted chat must not re-materialize its run.
   */
  evictChat(chatId: string, options: { force?: boolean } = {}): void {
    if (!options.force && this.runs[chatId]?.running) return;
    const cancelFlush = this.#pendingFlush.get(chatId);
    if (cancelFlush) {
      cancelFlush();
      this.#pendingFlush.delete(chatId);
    }
    this.#steerReplies.delete(chatId);
    this.#stopEpoch.delete(chatId);
    this.#startingTurns.delete(chatId);
    if (options.force) {
      for (const pending of approvalsStore.forChat(chatId)) this.#engineSettled.add(pending.id);
      approvalsStore.clearForChat(chatId);
    }
    if (this.runs[chatId]) {
      const next = { ...this.runs };
      delete next[chatId];
      this.runs = next;
    }
    this.#sessionIds.delete(chatId);
    this.#conversationIndices.delete(chatId);
  }

  /** True once an engine session has been started for this chat. */
  hasSession(chatId: string): boolean {
    return this.#sessionIds.has(chatId);
  }

  #requireRun(chatId: string): AgenteRun {
    if (!this.runs[chatId]) {
      // Recover once from the persisted transcript, not from its tail: a steer
      // or follow-up may be the last message when live state is lost on reload.
      const chat = appStore.chats.find((c) => c.id === chatId);
      const assistant = chat?.messages.slice().reverse().find((message) => message.role === 'assistant' && message.status === 'streaming');
      this.runs[chatId] = {
        chatId,
        running: !!assistant,
        assistantMessageId: assistant?.id,
        checkpoints: [],
        queuedCount: 0,
        ...createCodeRunState(),
        content: assistant?.content || '',
        timeline: restoreTimeline(assistant),
        todos: conversationTodos(chat?.messages ?? []),
        reasoning: assistant?.reasoning || '',
        reasoningRaw: assistant?.reasoning || '',
        steps: assistant?.agentSteps?.map((step) => ({ ...step })) || []
      };
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
    const chat = appStore.chats.find((c) => c.id === event.chatId);
    if (!chat) return;

    if ((event.type === 'compaction_start' || event.type === 'compaction_end') && !run.running) {
      let note = [...chat.messages].reverse().find(message => message.metadata?.codeCompaction?.running);
      if (!note) {
        note = { id: createId('compaction'), role: 'assistant', content: '', createdAt: Date.now(), status: 'idle', done: true, metadata: { codeCompaction: { running: true } } };
        chat.messages.push(note);
        note = chat.messages.at(-1)!;
      }
      if (event.type === 'compaction_end') {
        note.metadata!.codeCompaction = { running: false, success: event.success, tokensBefore: event.tokensBefore, tokensAfter: event.tokensAfter, smart: event.smart, summary: event.summary, requestedSmart: event.requestedSmart, modelTokens: event.modelTokens, inputTokens: event.inputTokens, outputTokens: event.outputTokens, cacheReadTokens: event.cacheReadTokens, cacheWriteTokens: event.cacheWriteTokens };
        if (event.success && event.tokensBefore !== event.tokensAfter) for (const message of chat.messages) if (message.metadata) delete message.metadata.codeConversationIndex;
      }
      appStore.markChatDirty(chat.id);
      appStore.persist();
      return;
    }

    if (event.type === 'agent_start' && run.done) {
      // A queued follow-up is a new Rust turn: give its deltas a fresh target.
      const todos = conversationTodos(chat.messages);
      Object.assign(run, createCodeRunState(), { todos, running: true, assistantMessageId: undefined });
      // It starts the oldest follow-up, which already sits right above —
      // or a steer that reached main after the turn closed, which main sends
      // as the next turn: it joins the thread now, as the turn it starts.
      const followUp = chat.messages.find((message) => message.metadata?.codeQueued);
      if (followUp) delete followUp.metadata!.codeQueued;
      else {
        const steer = chat.pendingPrompts?.find((item) => item.sending);
        if (steer) {
          chat.pendingPrompts = chat.pendingPrompts!.filter((item) => item !== steer);
          this.#appendUserTurn(chat, steer.content, steer.codeAttachments ?? []);
          appStore.persistDraft(chat.id);
        }
      }
      this.#appendAssistant(chat);
    }

    if (event.type === 'runtime_event' && event.event.type === 'user_messages_injected') {
      this.#placeInjected(chat, run, event.event.messages.length);
    }
    applyCodeAgentEvent(run, event);
    if (event.type === 'compaction_end' && event.success && event.tokensBefore !== undefined) {
      for (const message of chat.messages) {
        if (message.metadata) delete message.metadata.codeConversationIndex;
      }
    }
    if (event.type === 'agent_start') {
      // A follow-up's agent_start belongs to the same transcript turn — bind
      // the run to the streaming assistant message even when the run state
      // was re-created without one (post-reload recovery).
      run.assistantMessageId ??= chat.messages.slice().reverse().find((message) => message.role === 'assistant' && message.status === 'streaming')?.id;
      run.running = true;
      run.queuedCount = 0;
    }
    if (event.type === 'runtime_event' && event.event.type === 'user_messages_injected') {
      run.queuedCount = Math.max(0, run.queuedCount - event.event.messages.length);
    }
    if (event.type === 'steer_acknowledged' && event.accepted) {
      // Authoritative receipt replaces the local approximation: the engine
      // tells us exactly how many steers are still queued.
      run.queuedCount = event.queuedCount ?? Math.max(0, run.queuedCount - 1);
    }
    if (run.done) run.running = false;
    if (event.type === 'agent_end') {
      run.queuedCount = 0;
      const stoppedByUser = run.stopping;
      run.stopping = false;
      this.#clearQueued(chat);
      // A steer the agent never read goes back to the panel, editable.
      for (const item of chat.pendingPrompts ?? []) item.sending = false;
      appStore.persistDraft(chat.id);
      const normal = !stoppedByUser && event.stopReason !== 'aborted' && event.stopReason !== 'error' && !run.error;
      const stopEpoch = this.#stopEpoch.get(chat.id) ?? 0;
      const mayContinue = () => (this.#stopEpoch.get(chat.id) ?? 0) === stopEpoch && !this.runFor(chat.id)?.running;
      // The engine commits a steer that lands as the turn closes to the
      // history without an answer. Drop the empty reply opened for it; after
      // a normal end, ask for the answer unless a queued prompt goes next.
      const steerReply = this.#steerReplies.get(chat.id);
      this.#steerReplies.delete(chat.id);
      const unanswered = steerReply !== undefined && steerReply === run.assistantMessageId && this.#dropEmptyReply(chat, run);
      if (normal && unanswered && !chat.pendingPrompts?.length) {
        setTimeout(() => { if (mayContinue()) void this.send(chat.id, get(t)('code.continuePrompt')); }, 0);
      }
      // A normal completion runs the oldest locally queued prompt. A stopped
      // or failed run leaves it editable; it never surprises the user by restarting.
      else if (normal) {
        setTimeout(() => { if (mayContinue()) void this.sendQueuedNow(chat.id); }, 0);
      }
      void this.refreshCheckpoints(event.chatId);
    }
    if (event.type === 'approval_resolved') {
      // Settled by the engine (Stop, shutdown) or echoing our own answer: in
      // both cases the buttons must go and nothing must be sent back.
      if (approvalsStore.items.some((item) => item.id === event.requestId)) {
        this.#engineSettled.add(event.requestId);
        approvalsStore.resolve(event.requestId, event.decision === 'allow');
      }
    }
    if (event.type === 'agent_end' || event.type === 'error') {
      for (const pending of approvalsStore.forChat(event.chatId)) this.#engineSettled.add(pending.id);
      approvalsStore.clearForChat(event.chatId);
    }
    if (isStreamingDelta(event)) this.#scheduleFlush(event.chatId, run);
    else this.#flushNow(event.chatId, run);

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
          cwd: project?.rootPath || 'project',
          dangerous: event.dangerous,
          reason: event.reason
        });
        if (this.#engineSettled.delete(event.requestId)) return;
        await respondToCodeAgentApproval(event.chatId, event.requestId, allow ? 'allow' : 'deny').catch(() => {});
      })();
    }
  }

  /**
   * Token-rate events (text/thinking deltas, tool output) arrive faster than
   * the screen refreshes; mirroring each one re-runs every dependent derived
   * and markdown pass. They land in the run at once and reach the message
   * once per frame.
   */
  #scheduleFlush(chatId: string, run: AgenteRun): void {
    if (this.#pendingFlush.has(chatId)) return;
    const flush = () => {
      this.#pendingFlush.delete(chatId);
      this.#flushToMessage(chatId, run);
    };
    // A hidden window gets no frames; a short timer keeps it current.
    if (typeof requestAnimationFrame === 'function' && typeof document !== 'undefined' && !document.hidden) {
      const id = requestAnimationFrame(flush);
      this.#pendingFlush.set(chatId, () => cancelAnimationFrame(id));
    } else {
      const id = setTimeout(flush, 16);
      this.#pendingFlush.set(chatId, () => clearTimeout(id));
    }
  }

  /** Flush synchronously, dropping any frame-scheduled flush for the chat. */
  #flushNow(chatId: string, run: AgenteRun): void {
    const cancel = this.#pendingFlush.get(chatId);
    if (cancel) {
      cancel();
      this.#pendingFlush.delete(chatId);
    }
    this.#flushToMessage(chatId, run);
  }

  /** Mirror run state into the streaming assistant message of the chat. */
  #flushToMessage(chatId: string, run: AgenteRun): void {
    const chat = appStore.chats.find((c) => c.id === chatId);
    if (!chat) return;
    const message = chat.messages.find((message) => message.id === run.assistantMessageId);
    if (!message || message.role !== 'assistant' || message.status !== 'streaming') return;
    message.content = run.content;
    message.reasoning = run.reasoning || undefined;
    message.agentSteps = run.done ? run.steps.map((step) => ({ ...step })) : run.steps;
    message.metadata = {
      ...message.metadata,
      codeTimeline: run.done ? run.timeline.map((entry) => ({ ...entry })) : run.timeline,
      codeChildren: run.done ? structuredClone($state.snapshot(run.children)) : run.children,
      codeSpend: { ...run.spend },
      codeTodos: run.todos.map((todo) => ({ ...todo })),
      ...(run.usage ? { codeUsage: { ...run.usage } } : {}),
      ...(run.tokensPerSecond ? { tokensPerSecond: run.tokensPerSecond } : {}),
      codeDiagnostics: [...run.diagnostics]
    };
    if (run.done) {
      message.status = run.error ? 'error' : 'idle';
      message.done = true;
      const elapsed = run.startedAt !== undefined ? codeRunElapsed(run) : undefined;
      message.metadata = {
        ...message.metadata,
        ...(elapsed ? { codeElapsedMs: elapsed } : {}),
        ...(run.hitTurnLimit ? { codeHitTurnLimit: true } : {})
      };
      // The reason belongs on the message — the transcript renders it, not
      // just a generic "failed" card.
      if (run.error) {
        message.metadata = { ...message.metadata, error: true, errorMessage: run.error };
      } else if (run.stopReason) {
        message.metadata = { ...message.metadata, codeStopReason: run.stopReason };
      }
      appStore.markChatDirty(chatId);
      appStore.persist();
    }
  }

  /**
   * The model took `count` queued messages mid-run: close the reply so far,
   * move them right under it and stream what follows into a new reply, so
   * the transcript reads in the order the model saw it.
   */
  #placeInjected(chat: ChatSession, run: AgenteRun, count: number): void {
    const taken = (chat.pendingPrompts ?? []).filter(item => item.sending).slice(0, count);
    const queued = chat.messages.filter((message) => message.metadata?.codeQueued).slice(0, Math.max(0, count - taken.length));
    if (!queued.length && !taken.length) return;
    const reply = chat.messages.find((message) => message.id === run.assistantMessageId);
    if (reply?.status === 'streaming') {
      this.#flushToMessage(chat.id, run);
      // Closed without `done`: no end-of-run footer on the first half.
      reply.status = 'idle';
      if (!reply.content && !reply.agentSteps?.length && !reply.reasoning) chat.messages.splice(chat.messages.indexOf(reply), 1);
    }
    chat.messages = [...chat.messages.filter((message) => !queued.includes(message)), ...queued];
    for (const message of queued) delete message.metadata!.codeQueued;
    for (const item of taken) this.#appendUserTurn(chat, item.content, item.codeAttachments ?? []);
    chat.pendingPrompts = chat.pendingPrompts?.filter(item => !taken.some(taken => taken.id === item.id));
    appStore.persistDraft(chat.id);
    // A fresh reply for the continuation; run-wide state (usage, spend,
    // todos, timing) carries on, and still-running subagents stay visible.
    Object.assign(run, { content: '', timeline: [], reasoning: '', reasoningRaw: '', steps: [], children: run.children.filter((child) => child.status === 'running') });
    this.#appendAssistant(chat);
    if (run.assistantMessageId) this.#steerReplies.set(chat.id, run.assistantMessageId);
  }

  /** The reply opened for an injected steer, if nothing came of it: remove it. */
  #dropEmptyReply(chat: ChatSession, run: AgenteRun): boolean {
    const reply = chat.messages.find((message) => message.id === run.assistantMessageId);
    // The run, not the message: agent_end lands before the final flush.
    if (!reply || reply.role !== 'assistant' || run.content.trim() || run.steps.length || run.reasoning.trim() || reply.content.trim()) return false;
    chat.messages = chat.messages.filter((message) => message !== reply);
    appStore.markChatDirty(chat.id);
    appStore.persist();
    return true;
  }

  /** Nothing is waiting once a run ends: whatever it never took stays where it was sent. */
  #clearQueued(chat: ChatSession): void {
    for (const message of chat.messages) if (message.metadata?.codeQueued) delete message.metadata.codeQueued;
  }

  /** Append a user message to a chat transcript (no assistant placeholder). */
  #appendUserTurn(chat: ChatSession, text: string, attachments: Attachment[] = [], queued = false): void {
    const conversationIndex = !this.runs[chat.id]?.assistantMessageId && this.#conversationIndices.has(chat.id)
      ? { codeConversationIndex: this.#conversationIndices.get(chat.id) } : {};
    const metadata = { ...conversationIndex, ...(queued ? { codeQueued: true } : {}) };
    chat.messages.push({
      id: createId('msg'),
      role: 'user',
      content: text,
      ...(Object.keys(metadata).length ? { metadata } : {}),
      createdAt: Date.now()
    });
    if (attachments.length) chat.messages.at(-1)!.metadata = { ...chat.messages.at(-1)!.metadata, codeAttachments: attachments.map((attachment) => ({ ...attachment })) };
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
    this.#appendAssistant(chat);
  }

  private modelLabelFor(chat: ChatSession): string {
    const llm = appStore.configForChat(chat).llm;
    return llm?.backend_mode === 'local' || !llm?.provider ? llm?.local?.model ?? '' : llm.providers?.[llm.provider]?.model ?? '';
  }

  #appendAssistant(chat: ChatSession): void {
    const assistantMessageId = createId('msg');
    this.#requireRun(chat.id).assistantMessageId = assistantMessageId;
    chat.messages.push({
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      status: 'streaming',
      mode: 'agent',
      agentSteps: [],
      metadata: { modelName: chat.modelSelection?.backendMode === 'local' ? chat.modelSelection.localModel : chat.modelSelection?.model || this.modelLabelFor(chat) }
    });
    appStore.markChatDirty(chat.id);
    appStore.persist();
  }

  /**
   * Start (or resume) the engine session for a chat and send the prompt.
   * While a run is active the prompt becomes a steer — course correction,
   * recorded in the transcript like any other user turn.
   * The assistant placeholder message streams live from code_agent_event.
   */
  async send(chatId: string, text: string, attachments: Attachment[] = []): Promise<void> {
    await this.#runTurn(chatId, text, () => promptCodeAgent(chatId, text, attachments), attachments);
  }

  /** `!command`: run it in the project's shell, outside the model (the TUI's `!`). */
  async exec(chatId: string, command: string): Promise<void> {
    await this.#runTurn(chatId, `!${command}`, () => execCodeCommand(chatId, command));
  }

  /** Start (or resume) the session, record the turn, then `start` it. */
  async #runTurn(chatId: string, text: string, start: () => Promise<{ ok: boolean; error?: string; conversationIndex?: number }>, attachments: Attachment[] = []): Promise<void> {
    if (!text.trim()) return;
    if (this.runs[chatId]?.running || this.#startingTurns.has(chatId)) {
      this.queue(chatId, text, attachments);
      return;
    }
    this.#startingTurns.add(chatId);
    let chat: ChatSession | undefined;
    let project: CodeProject | null = null;
    let run: AgenteRun;
    try {
      // A turn appends to the history: it must be loaded first (session goals and
      // computer use can send into a chat nobody has opened this launch).
      await appStore.ensureChatMessages(chatId);
      chat = appStore.chats.find((c) => c.id === chatId);
      project = this.projectById(chat?.projectId ?? null);
      if (!chat || !project) return;

      run = this.#requireRun(chatId);
      if (run.running) {
        this.queue(chatId, text, attachments);
        return;
      }

      // Keep the last usage report visible between runs — the next turn
      // refreshes it; it should not blank while the first reply streams.
      const previousUsage = run.usage;
      const todos = conversationTodos(chat.messages);
      Object.assign(run, createCodeRunState(), {
        todos,
        running: true,
        assistantMessageId: undefined,
        error: undefined,
        stopReason: undefined,
        queuedCount: 0,
        checkpoints: run.checkpoints,
        usage: previousUsage
      });
    } finally {
      this.#startingTurns.delete(chatId);
    }
    this.#ensureEventSubscription();

    const failure = await this.#ensureSession(chat, project);
    if (failure) {
      run.running = false;
      run.done = true;
      run.error = failure;
      // A failed start is still a turn: show what was asked and why it
      // failed instead of swallowing both.
      this.#appendTurnPair(chat, text);
      this.#flushToMessage(chatId, run);
      return;
    }

    this.#appendTurnPair(chat, text);
    this.#touchProject(project.id);
    const userMessage = chat.messages.at(-2)!;
    if (attachments.length) userMessage.metadata = { ...userMessage.metadata, codeAttachments: attachments.map((attachment) => ({ ...attachment })) };

    try {
      const result = await start();
      if (result.ok) {
        if (result.conversationIndex !== undefined) {
          userMessage.metadata = { ...userMessage.metadata, codeConversationIndex: result.conversationIndex };
          appStore.markChatDirty(chatId);
          appStore.persist();
        }
        return;
      }
      run.error = result.error || 'Failed to start the coding agent.';
    } catch (err: unknown) {
      run.error = err instanceof Error ? err.message : String(err);
    }
    run.running = false;
    run.done = true;
    run.queuedCount = 0;
    this.#flushToMessage(chatId, run);
  }

  /** Make sure the chat has an engine session on the model the picker shows; an error message if not. */
  async #ensureSession(chat: ChatSession, project: { rootPath: string }): Promise<string | null> {
    const chatId = chat.id;
    try {
      if (this.#sessionIds.has(chatId)) {
        // The picker may have changed since the session started (possibly while
        // another conversation was on screen): run with what it shows now.
        await this.#syncSelectedModel(chat);
        const sessionId = this.#sessionIds.get(chatId)!;
        const snapshot = await invoke<{ snapshot: SessionSnapshot }>('agente_session_snapshot', { sessionId }).catch(() => undefined);
        if (snapshot) this.#conversationIndices.set(chatId, snapshot.snapshot.conversation.length);
        return null;
      }
      const { provider, model } = await currentProviderModel(appStore.configForChat(chat));
      const runtimeMode = chat.codeAgent?.runtimeMode || this.defaultMode;
      const resumeSessionId = chat.codeAgent?.sessionId || undefined;
      const { sessionId, conversationIndex } = await startCodeAgentSession({
        chatId,
        projectRoot: project.rootPath,
        provider,
        model,
        localSelection: chat.modelSelection ? { modelPath: chat.modelSelection.localModelPath, baseUrl: chat.modelSelection.localBaseUrl } : undefined,
        runtimeMode,
        resumeSessionId,
        ...(chat.reasoningLevel ? { thinkingLevel: chat.reasoningLevel } : {})
      });
      this.#sessionIds.set(chatId, sessionId);
      if (conversationIndex !== undefined) this.#conversationIndices.set(chatId, conversationIndex);
      if (chat.codeAgent) {
        chat.codeAgent.sessionId = sessionId;
        chat.codeAgent.updatedAt = Date.now();
      }
      return null;
    } catch (err: unknown) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  async #syncSelectedModel(chat: ChatSession): Promise<void> {
    const { provider, model } = await currentProviderModel(appStore.configForChat(chat));
    if (model || provider === 'local') await setAgenteModel(chat.id, provider, model, chat.reasoningLevel || undefined, chat.modelSelection ? { modelPath: chat.modelSelection.localModelPath, baseUrl: chat.modelSelection.localBaseUrl } : undefined);
  }

  /** Keep unsent input outside the transcript until the engine consumes it. */
  queue(chatId: string, text: string, attachments: Attachment[] = []): void {
    appStore.queuePrompt(chatId, text, { codeAttachments: attachments.map(item => ({ ...item })) });
  }

  /** Hand queued prompts to the engine now: one by `id`, or every waiting one. */
  async sendQueuedNow(chatId: string, id?: string): Promise<void> {
    const chat = appStore.chats.find(chat => chat.id === chatId);
    if (!chat) return;
    const waiting = chat.pendingPrompts?.filter(item => !item.sending && (!id || item.id === id)) ?? [];
    if (!waiting.length) return;
    if (!this.runFor(chatId)?.running) {
      const item = waiting[0]!;
      chat.pendingPrompts = chat.pendingPrompts!.filter(entry => entry.id !== item.id);
      appStore.persistDraft(chatId);
      await this.send(chatId, item.content, item.codeAttachments ?? []);
      return;
    }
    // Lock the batch before IPC, so rapid Enter presses cannot send it twice.
    for (const item of waiting) item.sending = true;
    appStore.persistDraft(chatId);
    for (const item of waiting) {
      try {
        const result = await steerCodeAgent(chatId, item.content, item.codeAttachments ?? []);
        if (!result.ok) item.sending = false;
      } catch { item.sending = false; }
    }
    appStore.persistDraft(chatId);
  }

  /**
   * Course-correct mid-run: hands the message to the engine, which reads it
   * after the current tool batch; until then it waits in the panel.
   */
  async steer(chatId: string, text: string, attachments: Attachment[] = []): Promise<void> {
    const item = appStore.queuePrompt(chatId, text, { codeAttachments: attachments.map((attachment) => ({ ...attachment })) });
    if (!item) return;
    // "Next step" in the waiting panel; it joins the thread when the agent reads it.
    item.sending = true;
    appStore.persistDraft(chatId);
    const run = this.#requireRun(chatId);
    run.queuedCount += 1;
    try {
      const result = await steerCodeAgent(chatId, text, attachments);
      if (result.ok) return;
      // The message stays in the panel to edit or resend; say why.
      if (result.error) toastStore.error(result.error);
    } catch { /* falls through: back to the panel */ }
    this.#rollbackQueued(run);
    item.sending = false;
    appStore.persistDraft(chatId);
  }

  /** Queue input that runs only when the agent would otherwise stop. */
  async followUp(chatId: string, text: string, attachments: Attachment[] = []): Promise<void> {
    const chat = appStore.chats.find((c) => c.id === chatId);
    if (!chat || !text.trim()) return;
    const run = this.#requireRun(chatId);
    if (!run.running) {
      await this.send(chatId, text, attachments);
      return;
    }
    this.#appendUserTurn(chat, text, attachments, true);
    run.queuedCount += 1;
    try {
      const result = await followUpCodeAgent(chatId, text, attachments);
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
    // Say it now: the engine needs a moment to unwind, and until it does the
    // run would keep animating as if nothing had been asked of it.
    const run = this.runFor(chatId);
    this.#stopEpoch.set(chatId, (this.#stopEpoch.get(chatId) ?? 0) + 1);
    if (run) run.stopping = true;
    await abortCodeAgent(chatId);
  }

  async setMode(chatId: string, mode: 'full' | 'supervised' | 'plan'): Promise<void> {
    const chat = appStore.chats.find((c) => c.id === chatId);
    if (chat?.codeAgent) {
      chat.codeAgent.runtimeMode = mode;
      chat.codeAgent.updatedAt = Date.now();
    }
    appStore.markChatDirty(chatId);
    appStore.persist();
    try {
      localStorage.setItem(DEFAULT_MODE_KEY, mode);
    } catch {
      // Blocked storage: the choice applies to this conversation only.
    }
    /*
     * Full mode approves every tool call. A prompt still on screen is a
     * question the user just answered globally, so answer it here: the engine
     * holds the run until its own approval is settled, and changing the mode
     * does not reach a request that is already waiting. Leaving it would strand
     * the turn behind buttons for a decision that no longer exists.
     */
    if (mode === 'full') {
      for (const pending of approvalsStore.forChat(chatId)) approvalsStore.resolve(pending.id, true);
    }
    await setCodeAgentRuntimeMode(chatId, mode);
  }

  async compact(chatId: string, smart = true): Promise<{ ok: boolean; error?: string }> {
    await this.ensureSession(chatId);
    return compactCodeAgent(chatId, smart);
  }

  async actOnMessage(chatId: string, messageId: string, action: 'fork' | 'rewind'): Promise<void> {
    await appStore.ensureChatMessages(chatId);
    const chat = appStore.chats.find((item) => item.id === chatId);
    const project = this.projectById(chat?.projectId ?? null);
    const index = chat?.messages.findIndex((item) => item.id === messageId) ?? -1;
    const message = chat?.messages[index];
    if (!chat || !project || !message || message.metadata?.codeConversationIndex === undefined) return;
    if (this.runFor(chatId)?.running) throw new Error('Wait for the turn to finish.');
    const failure = await this.#ensureSession(chat, project);
    if (failure) throw new Error(failure);
    const result = await codeMessageAction(chatId, action, message.metadata.codeConversationIndex);
    const previous = structuredClone($state.snapshot(chat.messages.slice(0, index)));
    if (action === 'fork') {
      const created = this.newConversation(project);
      const fork = appStore.chats.find((item) => item.id === created.id)!;
      fork.messages = previous;
      fork.title = `${chat.title} (fork)`;
      fork.codeAgent = { ...chat.codeAgent!, sessionId: result.sessionId, updatedAt: Date.now() };
      fork.draft = message.content;
      appStore.markChatDirty(fork.id);
    } else {
      chat.messages = previous;
      chat.draft = message.content;
      this.evictChat(chatId);
      appStore.markChatDirty(chatId);
      window.dispatchEvent(new CustomEvent('code-composer-draft', { detail: message.content }));
    }
    appStore.persist();
  }

  async refreshCheckpoints(chatId: string): Promise<void> {
    const chat = appStore.chats.find((c) => c.id === chatId);
    const run = this.#requireRun(chatId);
    run.checkpoints = await listCodeAgentCheckpoints(chatId, chat?.codeAgent?.sessionId).catch(() => []);
  }

  /**
   * Put the project's files back to how they were before `turnIndex`, after
   * the user confirmed. The transcript keeps a note so the conversation shows
   * what happened; the result says which files changed.
   */
  async restoreCheckpoint(chatId: string, turnIndex: number): Promise<{ ok: boolean; files: string[]; error?: string }> {
    const chat = appStore.chats.find((c) => c.id === chatId);
    const project = this.projectById(chat?.projectId ?? null);
    if (!chat || !project) return { ok: false, files: [], error: 'No project for this conversation' };
    const result = await rollbackCodeAgent(chatId, turnIndex, {
      sessionId: chat.codeAgent?.sessionId,
      projectRoot: project.rootPath
    }).catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err), files: [] }));
    if (result.ok) {
      chat.messages.push({
        id: createId('msg'),
        role: 'assistant',
        content: '',
        createdAt: Date.now(),
        done: true,
        status: 'idle',
        metadata: { codeNote: `restore:${result.files?.length ?? 0}` }
      });
      appStore.markChatDirty(chatId);
      appStore.persist();
    }
    await this.refreshCheckpoints(chatId);
    return { ok: !!result.ok, files: result.files ?? [], error: result.error };
  }
}

const EXPANDED_KEY = 'flaxeo.code.expandedProjects';

function readExpanded(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeExpanded(value: Record<string, boolean>): void {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify(value));
  } catch {
    // Blocked storage: expansion lasts for this session only.
  }
}

function sortByActivity(projects: CodeProject[]): CodeProject[] {
  return [...projects].sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
}

function folderName(rootPath: string): string {
  const segments = rootPath.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || rootPath;
}

function samePath(a: string, b: string): boolean {
  const norm = (value: string) => value.replace(/[\\/]+$/, '').replace(/\\/g, '/');
  return norm(a) === norm(b);
}

/** A saved run's order of text and steps; older messages get steps, then text. */
function restoreTimeline(message: ChatSession['messages'][number] | undefined): CodeTimelineEntry[] {
  if (!message) return [];
  const saved = message.metadata?.codeTimeline;
  if (Array.isArray(saved) && saved.length) return saved.map((entry) => ({ ...entry }));
  const entries: CodeTimelineEntry[] = (message.agentSteps ?? []).map((step) => ({ kind: 'step', id: step.id }));
  if (message.content) entries.push({ kind: 'text', text: message.content });
  return entries;
}

function summarizeArgs(args: unknown): string {
  if (args && typeof args === 'object') {
    const record = args as Record<string, unknown>;
    if (typeof record.command === 'string') return record.command;
    if (typeof record.path === 'string') return record.path;
    // Any other tool (MCP, patches): show the arguments, not just a name.
    const pairs = Object.entries(record).map(([key, value]) => `${key}=${typeof value === 'string' ? value.replace(/\s+/g, ' ') : JSON.stringify(value)}`);
    return pairs.join(' ').slice(0, 600);
  }
  return '';
}

const RUNTIME_DELTAS = new Set(['assistant_delta', 'child_delta', 'child_tool', 'generation_progress', 'tool_heartbeat', 'call_usage']);

/** Events that arrive at token rate and can share one flush per frame. */
function isStreamingDelta(event: CodeAgentEvent): boolean {
  if (event.type === 'text_delta' || event.type === 'thinking_delta' || event.type === 'tool_update') return true;
  return event.type === 'runtime_event' && RUNTIME_DELTAS.has(event.event.type);
}

export const codeStore = new CodeStore();

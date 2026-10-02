// ── Code workspace panes ───────────────────────────────────────────────
// Layout and live state for the panes around the Code conversation: the
// Changes pane on the right, and the bottom dock with terminals and the
// agent's background processes. Layout choices are remembered per viewer.

import { conversationScope } from '$shared/workspace-scope';
import { invoke, listen } from '$lib/services/bridge';
import type { ChangeList, FileDiff, ProcessEvent, ProcessInfo, TerminalEvent } from '$shared/code-workspace';
import type { PresentedPlan } from './plan-review';
import type { FileEdit } from './work-blocks';
import { workspaceLayout } from '$lib/stores/workspace-layout.svelte';

type BottomTab = 'processes' | `terminal:${string}`;

const MAX_PROCESS_OUTPUT = 120_000;

export interface TerminalTab {
  id: string;
  title: string;
  cwd: string;
  exited: boolean;
  scope?: string;
}

export class CodeWorkspaceStore {

  processes = $state<ProcessInfo[]>([]);
  /** Output per process id, ANSI included (the viewer strips it). */
  processOutput = $state<Record<string, string>>({});
  selectedProcesses = $state<Record<string, string | null>>({});
  get selectedProcessId(): string | null { return this.selectedProcesses[workspaceLayout.scope] ?? null; }
  set selectedProcessId(id: string | null) { this.selectedProcesses[workspaceLayout.scope] = id; }

  terminals = $state<TerminalTab[]>([]);
  #terminalListeners = new Map<string, (data: string) => void>();
  #terminalBacklog = new Map<string, string>();

  /** What the Changes pane in the right dock shows: the open Code conversation. */
  changesTarget = $state<{ chatId: string; projectRoot: string; sessionId?: string } | null>(null);

  changeLists = $state<Record<string, ChangeList | null>>({});
  changeLoading = $state<Record<string, boolean>>({});
  #changeRequests = new Map<string, number>();
  get changes(): ChangeList | null { return this.changesTarget ? this.changesFor(this.changesTarget.chatId) : null; }
  changesFor(chatId: string): ChangeList | null { return this.changeLists[chatId] ?? null; }

  #wired = false;

  // ── Layout ───────────────────────────────────────────────────────────
  toggleChanges(open = !workspaceLayout.isOpen('changes')): void {
    if (open) workspaceLayout.show('changes'); else workspaceLayout.hide('changes');
  }

  /** A file the Changes pane should select next (a transcript edit's "View changes"). */
  focusPaths = $state<Record<string, string | null>>({});
  get focusPath(): string | null { return this.focusPaths[workspaceLayout.scope] ?? null; }
  set focusPath(path: string | null) { this.focusPaths[workspaceLayout.scope] = path; }

  /** Each chat's edits as its transcript recorded them: the Changes pane's fallback where git sees nothing. */
  transcriptEdits = $state<Record<string, FileEdit[]>>({});

  setTranscriptEdits(chatId: string, edits: FileEdit[]): void {
    this.transcriptEdits[chatId] = edits;
  }

  showFileInChanges(path: string): void {
    this.focusPath = path;
    workspaceLayout.show('changes');
  }

  // ── Plan ─────────────────────────────────────────────────────────────
  /** The plan open in the right dock, like the agent browser beside the conversation. */
  plan = $state<{ chatId: string; plan: PresentedPlan | null } | null>(null);
  /** Remember every offered plan, including after switching chats or restarting. */
  #offeredPlans = new Set<string>();

  constructor() {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem('agente.offeredPlans') ?? '[]');
      if (Array.isArray(saved)) this.#offeredPlans = new Set(saved.filter((key): key is string => typeof key === 'string').slice(-256));
    } catch { /* Plans still open once per session when storage is unavailable. */ }
  }

  showPlan(chatId: string, plan: PresentedPlan): void {
    this.plan = { chatId, plan };
    workspaceLayout.forScope(conversationScope(chatId), (owner) => owner.show('plan'));
  }

  closePlan(): void {
    workspaceLayout.hide('plan');
  }

  togglePlan(chatId: string, plan: PresentedPlan | null): void {
    if (workspaceLayout.isOpen('plan')) this.closePlan();
    else { this.plan = { chatId, plan }; workspaceLayout.forScope(conversationScope(chatId), (owner) => owner.show('plan')); }
  }

  /** A newly presented plan opens once; after the viewer closes it, only "Open plan" brings it back. */
  offerPlan(chatId: string, plan: PresentedPlan): void {
    let hash = 2166136261;
    for (const char of plan.body) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    const key = `${chatId}\n${plan.path}\n${plan.body.length}:${hash}`;
    if (this.#offeredPlans.has(key)) return;
    this.#offeredPlans.add(key);
    this.#offeredPlans = new Set([...this.#offeredPlans].slice(-256));
    try { localStorage.setItem('agente.offeredPlans', JSON.stringify([...this.#offeredPlans])); } catch { /* Session-only. */ }
    this.showPlan(chatId, plan);
  }

  showBottom(tab?: BottomTab): void {
    workspaceLayout.show(tab ?? 'processes', 'bottom');
  }

  /** Toolbar toggle: show that tab, or hide the dock if it is already showing. */
  async toggleBottom(tab: 'processes' | 'terminal', cwd: string): Promise<void> {
    const terminals = this.terminalsForScope();
    if (tab === 'terminal' && terminals.some((term) => workspaceLayout.isOpen(`terminal:${term.id}`))) {
      for (const term of terminals) workspaceLayout.hide(`terminal:${term.id}`);
      return;
    }
    const id = tab === 'processes' ? 'processes' : terminals.at(-1) ? `terminal:${terminals.at(-1)!.id}` : null;
    if (id && workspaceLayout.isOpen(id)) {
      workspaceLayout.hide(id);
      return;
    }
    if (tab === 'processes') {
      this.showBottom('processes');
      return;
    }
    const last = terminals.at(-1);
    if (last) this.showBottom(`terminal:${last.id}`);
    else await this.newTerminal(cwd);
  }

  // ── Events ───────────────────────────────────────────────────────────
  wire(): void {
    if (this.#wired) return;
    this.#wired = true;
    void listen<ProcessEvent>('code_process_event', (event) => this.#onProcessEvent(event));
    void listen<TerminalEvent>('terminal_event', (event) => this.#onTerminalEvent(event));
    void invoke<ProcessInfo[]>('agente_process_list', {}).then((list) => {
      this.processes = list ?? [];
    }).catch(() => {});
  }

  #upsert(info: ProcessInfo): void {
    const index = this.processes.findIndex((p) => p.id === info.id);
    if (index >= 0) this.processes[index] = info;
    else this.processes = [...this.processes, info];
  }

  #onProcessEvent(event: ProcessEvent): void {
    if (event.type === 'process_output') {
      const next = (this.processOutput[event.id] ?? '') + event.chunk;
      this.processOutput[event.id] = next.length > MAX_PROCESS_OUTPUT ? next.slice(-MAX_PROCESS_OUTPUT) : next;
      return;
    }
    this.#upsert(event.process);
    if (event.type === 'process_start') {
      // Something new is running: show it, unless the user is in a terminal.
      this.selectedProcesses[conversationScope(event.process.chatId)] = event.process.id;
      workspaceLayout.forScope(conversationScope(event.process.chatId), (owner) => { if (!owner.isOpen('processes')) owner.show('processes', 'bottom'); });
    }
  }

  processesFor(chatId: string | null | undefined): ProcessInfo[] {
    return chatId ? this.processes.filter((p) => p.chatId === chatId) : [];
  }

  runningCount(chatId: string | null | undefined): number {
    return this.processesFor(chatId).filter((p) => p.status === 'running').length;
  }

  async loadProcessOutput(id: string): Promise<void> {
    if (this.processOutput[id] !== undefined) return;
    this.processOutput[id] = (await invoke<string>('agente_process_output', { id }).catch(() => '')) ?? '';
  }

  async startProcess(chatId: string, command: string, cwd: string): Promise<void> {
    await invoke('agente_process_start', { chatId, command, cwd });
  }

  async stopProcess(id: string): Promise<void> {
    await invoke('agente_process_stop', { id });
  }

  async clearFinished(chatId: string): Promise<void> {
    await invoke('agente_process_clear', { chatId });
    const gone = new Set(this.processesFor(chatId).filter((p) => p.status !== 'running').map((p) => p.id));
    this.processes = this.processes.filter((p) => !gone.has(p.id));
    for (const id of gone) delete this.processOutput[id];
    const scope = conversationScope(chatId);
    const selected = this.selectedProcesses[scope];
    if (selected && gone.has(selected)) this.selectedProcesses[scope] = null;
  }

  // ── Terminals ────────────────────────────────────────────────────────
  #onTerminalEvent(event: TerminalEvent): void {
    if (event.type === 'data') {
      const listener = this.#terminalListeners.get(event.id);
      if (listener) listener(event.data);
      else this.#terminalBacklog.set(event.id, (this.#terminalBacklog.get(event.id) ?? '') + event.data);
      return;
    }
    const tab = this.terminals.find((t) => t.id === event.id);
    if (tab) tab.exited = true;
  }

  /** The terminal view attaches here; anything printed before it mounted is replayed. */
  attachTerminal(id: string, write: (data: string) => void): () => void {
    this.#terminalListeners.set(id, write);
    const backlog = this.#terminalBacklog.get(id);
    if (backlog) {
      write(backlog);
      this.#terminalBacklog.delete(id);
    }
    return () => {
      if (this.#terminalListeners.get(id) === write) this.#terminalListeners.delete(id);
    };
  }

  terminalsForScope(scope = workspaceLayout.scope): TerminalTab[] { return this.terminals.filter((term) => term.scope === scope); }

  async newTerminal(cwd: string, size: { cols: number; rows: number } = { cols: 100, rows: 24 }): Promise<void> {
    const scope = workspaceLayout.scope;
    try {
      const { id, shell } = await invoke<{ id: string; shell: string }>('terminal_create', { cwd, ...size });
      const n = this.terminalsForScope(scope).length + 1;
      this.terminals = [...this.terminals, { id, title: n > 1 ? `${shell} ${n}` : shell, cwd, scope, exited: false }];
      workspaceLayout.forScope(scope, (owner) => owner.show(`terminal:${id}`, 'bottom'));
    } catch (error) {
      throw new Error(String((error as Error)?.message || error));
    }
  }

  writeTerminal(id: string, data: string): void {
    void invoke('terminal_write', { id, data });
  }

  resizeTerminal(id: string, cols: number, rows: number): void {
    void invoke('terminal_resize', { id, cols, rows });
  }

  closeTerminal(id: string): void {
    void invoke('terminal_kill', { id });
    const scope = this.terminals.find((term) => term.id === id)?.scope ?? workspaceLayout.scope;
    this.terminals = this.terminals.filter((t) => t.id !== id);
    this.#terminalListeners.delete(id);
    this.#terminalBacklog.delete(id);
    workspaceLayout.forScope(scope, (owner) => owner.forget(`terminal:${id}`));
  }

  // ── Changes ──────────────────────────────────────────────────────────
  async refreshChanges(args: { chatId: string; projectRoot: string; sessionId?: string }): Promise<void> {
    const id = args.chatId;
    const request = (this.#changeRequests.get(id) ?? 0) + 1;
    this.#changeRequests.set(id, request); this.changeLoading[id] = true;
    try {
      const list = await invoke<ChangeList>('agente_changes', args);
      if (this.#changeRequests.get(id) === request) this.changeLists[id] = list;
    } catch {
      if (this.#changeRequests.get(id) === request) this.changeLists[id] = { source: 'none', files: [] };
    } finally {
      if (this.#changeRequests.get(id) === request) this.changeLoading[id] = false;
    }
  }

  fileDiff(args: { chatId: string; projectRoot: string; sessionId?: string; path: string }): Promise<FileDiff> {
    return invoke<FileDiff>('agente_file_diff', args);
  }

  revertFile(args: { chatId: string; projectRoot: string; sessionId?: string; path: string }): Promise<{ ok: boolean; error?: string }> {
    return invoke('agente_revert_file', args);
  }
}

export const codeWorkspace = new CodeWorkspaceStore();

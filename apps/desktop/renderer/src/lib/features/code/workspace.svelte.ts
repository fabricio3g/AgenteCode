// ── Code workspace panes ───────────────────────────────────────────────
// Layout and live state for the panes around the Code conversation: the
// Changes pane on the right, and the bottom dock with terminals and the
// agent's background processes. Layout choices are remembered per viewer.

import { invoke, listen } from '$lib/services/bridge';
import type { ChangeList, FileDiff, ProcessEvent, ProcessInfo, TerminalEvent } from '$shared/code-workspace';
import type { PresentedPlan } from './plan-review';

type BottomTab = 'processes' | `terminal:${string}`;

interface Layout {
  changesOpen: boolean;
  bottomOpen: boolean;
  bottomHeight: number;
}

const LAYOUT_KEY = 'flaxeo.code.layout';
const DEFAULT_LAYOUT: Layout = { changesOpen: false, bottomOpen: false, bottomHeight: 260 };
const MAX_PROCESS_OUTPUT = 120_000;

function readLayout(): Layout {
  try {
    return { ...DEFAULT_LAYOUT, ...JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

export interface TerminalTab {
  id: string;
  title: string;
  cwd: string;
  exited: boolean;
}

class CodeWorkspaceStore {
  layout = $state<Layout>(readLayout());
  bottomTab = $state<BottomTab>('processes');

  processes = $state<ProcessInfo[]>([]);
  /** Output per process id, ANSI included (the viewer strips it). */
  processOutput = $state<Record<string, string>>({});
  selectedProcessId = $state<string | null>(null);

  terminals = $state<TerminalTab[]>([]);
  #terminalListeners = new Map<string, (data: string) => void>();
  #terminalBacklog = new Map<string, string>();

  /** What the Changes pane in the right dock shows: the open Code conversation. */
  changesTarget = $state<{ chatId: string; projectRoot: string; sessionId?: string } | null>(null);

  changes = $state<ChangeList | null>(null);
  changesLoading = $state(false);
  changesKey = '';

  #wired = false;

  // ── Layout ───────────────────────────────────────────────────────────
  #saveLayout(): void {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(this.layout));
    } catch {
      // Blocked storage: the layout lasts for this session.
    }
  }

  setLayout(patch: Partial<Layout>): void {
    this.layout = { ...this.layout, ...patch };
    this.#saveLayout();
  }

  toggleChanges(open = !this.layout.changesOpen): void {
    this.setLayout({ changesOpen: open });
  }

  /** A file the Changes pane should select next (a transcript edit's "View changes"). */
  focusPath = $state<string | null>(null);

  showFileInChanges(path: string): void {
    this.focusPath = path;
    this.setLayout({ changesOpen: true });
  }

  // ── Plan ─────────────────────────────────────────────────────────────
  /** The plan open in the right dock, like the agent browser beside the conversation. */
  plan = $state<{ chatId: string; plan: PresentedPlan } | null>(null);
  /** The last plan offered on its own, so closing it keeps it closed. */
  #offeredPlan = '';

  showPlan(chatId: string, plan: PresentedPlan): void {
    this.plan = { chatId, plan };
  }

  closePlan(): void {
    this.plan = null;
  }

  /** A newly presented plan opens once; after the viewer closes it, only "Open plan" brings it back. */
  offerPlan(chatId: string, plan: PresentedPlan): void {
    const key = `${chatId}\n${plan.path}\n${plan.body}`;
    if (key === this.#offeredPlan) return;
    this.#offeredPlan = key;
    this.showPlan(chatId, plan);
  }

  showBottom(tab?: BottomTab): void {
    if (tab) this.bottomTab = tab;
    this.setLayout({ bottomOpen: true });
  }

  /** Toolbar toggle: show that tab, or hide the dock if it is already showing. */
  async toggleBottom(tab: 'processes' | 'terminal', cwd: string): Promise<void> {
    const onTab = tab === 'processes' ? this.bottomTab === 'processes' : this.bottomTab.startsWith('terminal:');
    if (this.layout.bottomOpen && onTab) {
      this.setLayout({ bottomOpen: false });
      return;
    }
    if (tab === 'processes') {
      this.showBottom('processes');
      return;
    }
    const last = this.terminals.at(-1);
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
      this.selectedProcessId = event.process.id;
      if (!this.layout.bottomOpen) this.showBottom('processes');
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
    if (this.selectedProcessId && gone.has(this.selectedProcessId)) this.selectedProcessId = null;
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

  async newTerminal(cwd: string, size: { cols: number; rows: number } = { cols: 100, rows: 24 }): Promise<void> {
    try {
      const { id, shell } = await invoke<{ id: string; shell: string }>('terminal_create', { cwd, ...size });
      const n = this.terminals.length + 1;
      this.terminals = [...this.terminals, { id, title: n > 1 ? `${shell} ${n}` : shell, cwd, exited: false }];
      this.showBottom(`terminal:${id}`);
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
    const index = this.terminals.findIndex((t) => t.id === id);
    this.terminals = this.terminals.filter((t) => t.id !== id);
    this.#terminalListeners.delete(id);
    this.#terminalBacklog.delete(id);
    if (this.bottomTab === `terminal:${id}`) {
      const next = this.terminals[Math.max(0, index - 1)];
      this.bottomTab = next ? `terminal:${next.id}` : 'processes';
    }
  }

  // ── Changes ──────────────────────────────────────────────────────────
  async refreshChanges(args: { chatId: string; projectRoot: string; sessionId?: string }): Promise<void> {
    const key = `${args.chatId}|${args.projectRoot}`;
    if (key !== this.changesKey) this.changes = null;
    this.changesKey = key;
    this.changesLoading = true;
    try {
      const list = await invoke<ChangeList>('agente_changes', args);
      if (this.changesKey === key) this.changes = list;
    } catch {
      if (this.changesKey === key) this.changes = { source: 'none', files: [] };
    } finally {
      if (this.changesKey === key) this.changesLoading = false;
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

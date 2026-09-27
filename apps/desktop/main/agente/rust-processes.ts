// ── Background processes of Rust-engine chats ──────────────────────────
// When a Code chat runs on the Rust runtime, `shell` with background: true
// starts its dev servers inside the runtime. The Processes pane is fed by
// ProcessEvents, so this bridge polls the runtime while such processes run
// and turns what changed into the same events. Ids carry an `rs-` prefix so
// the pane's stop and output calls reach the runtime, not Desktop's own
// process registry.

import type { AgenteClient } from '../agente-client.ts';
import type { ProcessEvent, ProcessInfo, ProcessStatus } from '../../shared/code-workspace.ts';

const PREFIX = 'rs-';
const POLL_MS = 2_000;
/** The runtime keeps this much of each process's output. */
const TAIL_CHARS = 256 * 1024;

type RuntimeProcess = {
  id: string;
  command: string;
  project_dir: string;
  started_at: number;
  status: ProcessStatus;
  exit_code: number | null;
  urls: string[];
};

export type ChatProject = { chatId: string; projectRoot: string };

export function isRustProcessId(id: string): boolean {
  return id.startsWith(PREFIX);
}

export class RustProcessBridge {
  private readonly known = new Map<string, ProcessInfo>();
  private readonly outputLength = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sink: (event: ProcessEvent) => void = () => {};

  constructor(
    private readonly client: () => Promise<AgenteClient> | null,
    private readonly projects: () => ChatProject[]
  ) {}

  onEvent(sink: (event: ProcessEvent) => void): void {
    this.sink = sink;
  }

  /** Something may have started: look now, and keep looking while it runs. */
  nudge(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.poll(), 300);
  }

  list(chatId?: string): ProcessInfo[] {
    const all = [...this.known.values()];
    return chatId ? all.filter((info) => info.chatId === chatId) : all;
  }

  async output(id: string): Promise<string> {
    const info = this.known.get(id);
    const client = this.client();
    if (!info || !client) return '';
    const result = await (await client).request<{ output: string }>('processes.output', { project_dir: info.cwd, id: this.runtimeId(id), tail_chars: TAIL_CHARS });
    return result.output;
  }

  async stop(id: string): Promise<boolean> {
    const info = this.known.get(id);
    const client = this.client();
    if (!info || !client) return false;
    const result = await (await client).request<{ stopped: boolean }>('processes.stop', { project_dir: info.cwd, id: this.runtimeId(id) });
    this.nudge();
    return result.stopped;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.known.clear();
    this.outputLength.clear();
  }

  private runtimeId(id: string): string {
    return id.slice(PREFIX.length);
  }

  private async poll(): Promise<void> {
    this.timer = null;
    const pending = this.client();
    if (!pending) return;
    const client = await pending.catch(() => null);
    if (!client) return;
    const roots = new Map(this.projects().map((project) => [project.projectRoot, project.chatId]));
    for (const [projectRoot, chatId] of roots) {
      const listed = await client.request<RuntimeProcess[]>('processes.list', { project_dir: projectRoot }).catch(() => []);
      for (const process of listed) await this.update(client, chatId, process);
    }
    if ([...this.known.values()].some((info) => info.status === 'running')) {
      this.timer = setTimeout(() => void this.poll(), POLL_MS);
    }
  }

  private async update(client: AgenteClient, chatId: string, process: RuntimeProcess): Promise<void> {
    const info = this.toInfo(chatId, process);
    const previous = this.known.get(info.id);
    this.known.set(info.id, info);
    if (!previous) this.sink({ type: 'process_start', process: info });
    await this.forwardOutput(client, info, process.id);
    if (previous) this.reportChanges(previous, info);
  }

  private toInfo(chatId: string, process: RuntimeProcess): ProcessInfo {
    const id = `${PREFIX}${process.id}`;
    const running = process.status === 'running';
    return {
      id,
      chatId,
      command: process.command,
      cwd: process.project_dir,
      pid: null,
      status: process.status,
      exitCode: process.exit_code,
      startedAt: process.started_at,
      endedAt: running ? null : (this.known.get(id)?.endedAt ?? Date.now()),
      urls: process.urls
    };
  }

  private reportChanges(previous: ProcessInfo, info: ProcessInfo): void {
    const newUrl = info.urls.find((url) => !previous.urls.includes(url));
    if (newUrl) this.sink({ type: 'process_url', process: info, url: newUrl });
    if (previous.status === 'running' && info.status !== 'running') this.sink({ type: 'process_exit', process: info });
  }

  private async forwardOutput(client: AgenteClient, info: ProcessInfo, runtimeId: string): Promise<void> {
    const result = await client
      .request<{ output: string }>('processes.output', { project_dir: info.cwd, id: runtimeId, tail_chars: TAIL_CHARS })
      .catch(() => ({ output: '' }));
    const seen = this.outputLength.get(info.id) ?? 0;
    // The runtime keeps a bounded tail: when it was trimmed, send what is new at the end.
    const chunk = result.output.length >= seen ? result.output.slice(seen) : result.output;
    this.outputLength.set(info.id, result.output.length);
    if (chunk) this.sink({ type: 'process_output', id: info.id, chatId: info.chatId, chunk });
  }
}

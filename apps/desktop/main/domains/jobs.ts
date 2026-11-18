import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import type { MediaJob } from '../../shared/domains.ts';

export type JobContext = { signal: AbortSignal; update(phase: string, progress?: number): void; owner: string };
function abortError(): Error { return Object.assign(new Error('Processing stopped'), { name: 'AbortError' }); }
export function checkAbort(signal: AbortSignal): void { if (signal.aborted) throw abortError(); }
export async function runProcess(binary: string, args: string[], ctx: JobContext, options: { cwd?: string; stdout?: (chunk: Buffer) => void; maxBytes?: number } = {}): Promise<{ stdout: Buffer; stderr: string }> {
  checkAbort(ctx.signal);
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], cwd: options.cwd });
    const chunks: Buffer[] = []; let bytes = 0; let stderr = ''; let failure: Error | undefined;
    const kill = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const abort = () => { failure = abortError(); kill(); };
    ctx.signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        if (options.stdout) options.stdout(chunk);
        else {
          bytes += chunk.length;
          if (bytes > (options.maxBytes ?? 16 * 1024 * 1024)) throw new Error('Process result is too large; request a shorter region.');
          chunks.push(chunk);
        }
      } catch (error) { failure = error as Error; kill(); }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-256 * 1024); });
    child.on('error', error => { failure = error; });
    child.on('close', code => {
      ctx.signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${binary.split(/[\\/]/).pop()} failed (${code}): ${stderr.slice(-3000)}`));
      else resolve({ stdout: Buffer.concat(chunks), stderr });
    });
    if (ctx.signal.aborted) abort();
  });
}
export class DomainJobs {
  private records = new Map<string, MediaJob>();
  private controllers = new Map<string, AbortController>();
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private emit: (job: MediaJob) => void = () => {}, private concurrency = 2) {}
  list(): MediaJob[] { return [...this.records.values()].map(job => structuredClone(job)); }
  cancel(id: string, owner?: string): void {
    const job = this.records.get(id);
    if (job && (!owner || job.owner === owner)) this.controllers.get(id)?.abort();
  }
  cancelOwner(owner: string): void { for (const job of this.records.values()) if (job.owner === owner) this.cancel(job.id, owner); }
  async run<T>(domain: string, operation: string, owner: string, signal: AbortSignal, work: (ctx: JobContext) => Promise<T>): Promise<T> {
    const id = crypto.randomUUID(); const controller = new AbortController();
    const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) controller.abort();
    const job: MediaJob = { id, owner, domain, operation, state: 'queued', phase: 'Waiting for a local worker', startedAt: Date.now() };
    this.records.set(id, job); this.controllers.set(id, controller); this.emit(structuredClone(job));
    const publish = () => this.emit(structuredClone(job));
    let admitted = false;
    try {
      await new Promise<void>(resolve => {
        const start = () => { this.active++; admitted = true; resolve(); };
        if (this.active < this.concurrency) start(); else this.queue.push(start);
      });
      checkAbort(controller.signal); job.state = 'running'; publish();
      const result = await work({ signal: controller.signal, owner, update: (phase, progress) => { checkAbort(controller.signal); job.phase = phase; job.progress = progress; publish(); } });
      checkAbort(controller.signal); job.state = 'completed'; job.phase = 'Complete'; job.progress = 1; job.result = result; return result;
    } catch (error) {
      job.state = controller.signal.aborted ? 'cancelled' : 'failed'; job.phase = job.state === 'cancelled' ? 'Stopped' : 'Failed'; job.error = (error as Error).message; throw error;
    } finally {
      job.endedAt = Date.now(); publish(); signal.removeEventListener('abort', abort); this.controllers.delete(id);
      if (admitted) { this.active--; this.queue.shift()?.(); }
      if (this.records.size > 200) for (const [oldId, old] of this.records) { if (['completed', 'failed', 'cancelled'].includes(old.state) && oldId !== id) { this.records.delete(oldId); break; } }
    }
  }
}

import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { getAppPaths } from './paths';
import { moduleDirname } from './module-env';

export class ChatDatabaseWorker {
  private worker: Worker | null = null;
  private nextId = 0;
  private closing = false;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  constructor(private readonly workerPath = join(moduleDirname(import.meta.url), 'chat-db-worker.cjs'), private readonly databasePath?: string,
    private readonly createWorker: (path: string, options: ConstructorParameters<typeof Worker>[1]) => Worker = (path, options) => new Worker(path, options)) {}
  request<T = unknown>(operation: string, ...args: unknown[]): Promise<T> {
    if (this.closing) return Promise.reject(new Error('Database is closing'));
    if (!this.worker) {
      const worker = this.createWorker(this.workerPath, { workerData: { databasePath: this.databasePath ?? join(getAppPaths().cacheRoot, 'chat-history.db') }, execArgv: [] });
      this.worker = worker;
      worker.unref();
      worker.on('message', ({ id, result, error }) => {
        if (this.worker !== worker) return;
        const request = this.pending.get(id);
        if (!request) return;
        this.pending.delete(id);
        if (error) request.reject(new Error(error)); else request.resolve(result);
      });
      const fail = (error: Error) => {
        // An old worker can emit exit after its replacement has accepted work.
        if (this.worker !== worker) return;
        for (const request of this.pending.values()) request.reject(error);
        this.pending.clear();
        if (this.worker === worker) this.worker = null;
      };
      worker.on('error', fail);
      worker.on('exit', code => { fail(new Error(`Database worker exited (${code})`)); });
    }
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      try { this.worker!.postMessage({ id, operation, args }); }
      catch (cause) { this.pending.delete(id); reject(cause); }
    });
  }
  async close(): Promise<void> {
    if (!this.worker || this.closing) return;
    const worker = this.worker;
    const drained = this.request('close');
    this.closing = true;
    try { await drained; } finally { await worker.terminate(); this.worker = null; }
  }
}

export const chatDatabase = new ChatDatabaseWorker();

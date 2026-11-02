/** Coalesce live snapshots before serialization; keep each owner's writes ordered. */
export class WriteQueue<T> {
  private entries = new Map<string, {
    value?: T; timer?: ReturnType<typeof setTimeout>; running?: Promise<void>;
    waiters: { resolve(): void; reject(error: unknown): void }[];
  }>();
  constructor(private write: (value: T) => Promise<void>, private delay = 120) {}

  enqueue(key: string, value: T): Promise<void> {
    let entry = this.entries.get(key);
    if (!entry) { entry = { waiters: [] }; this.entries.set(key, entry); }
    entry.value = value;
    const promise = new Promise<void>((resolve, reject) => entry!.waiters.push({ resolve, reject }));
    if (!entry.timer && !entry.running) entry.timer = setTimeout(() => { void this.flush(key); }, this.delay);
    return promise;
  }

  async flush(key?: string): Promise<void> {
    if (key === undefined) { await Promise.all([...this.entries.keys()].map(id => this.flush(id))); return; }
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
    if (entry.running) { await entry.running; return this.flush(key); }
    if (entry.value === undefined) return;
    const value = entry.value;
    const waiters = entry.waiters.splice(0);
    entry.value = undefined;
    entry.running = (async () => {
      try { await this.write(value); waiters.forEach(waiter => waiter.resolve()); }
      catch (error) { waiters.forEach(waiter => waiter.reject(error)); }
    })();
    await entry.running;
    entry.running = undefined;
    if (entry.value !== undefined) return this.flush(key);
    this.entries.delete(key);
  }
}

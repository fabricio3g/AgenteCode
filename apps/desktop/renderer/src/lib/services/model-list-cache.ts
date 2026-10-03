/** Short-lived API snapshots shared by the chat and provider pickers. */
export const MODEL_LIST_TTL_MS = 5 * 60_000;

type Entry<T> = { value?: T; at: number; pending?: Promise<T>; forced?: boolean };

export class ModelListCache<T> {
  private entries = new Map<string, Entry<T>>();

  peek(key: string): T | undefined {
    const entry = this.entries.get(key);
    return entry && Date.now() - entry.at < MODEL_LIST_TTL_MS ? entry.value : undefined;
  }

  load(key: string, fetcher: () => Promise<T>, force = false): Promise<T> {
    const previous = this.entries.get(key);
    if (previous?.pending && (!force || previous.forced)) return previous.pending;
    const cached = this.peek(key);
    if (!force && cached !== undefined) return Promise.resolve(cached);
    const entry: Entry<T> = { at: 0, forced: force };
    this.entries.set(key, entry);
    entry.pending = fetcher().then(value => {
      if (this.entries.get(key) === entry) {
        entry.value = value;
        entry.at = Date.now();
      }
      return value;
    }).finally(() => {
      entry.pending = undefined;
      if (entry.value === undefined && this.entries.get(key) === entry) this.entries.delete(key);
    });
    return entry.pending;
  }

  clear(): void { this.entries.clear(); }
}

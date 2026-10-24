/**
 * Which transcript disclosures the reader has opened.
 *
 * The transcript is mounted under `{#key chat.id}` (CodeSurface), so every
 * component holding its own `open` flag loses it the moment the reader looks at
 * another conversation and comes back — everything was collapsed again. The
 * shape of a conversation is the reader's, not the component's, so it lives
 * here, outside the tree that gets torn down.
 *
 * In memory for the run of the app: a reopened session starts from the
 * defaults, which are chosen so a first read is already the useful one.
 */

/** Past this many remembered rows the oldest are dropped (a long session's worth). */
const MAX_ENTRIES = 2000;

/**
 * The key for one row. Namespaced by chat and message so two messages cannot
 * collide on an index-derived entry key, and so the same row keeps its state
 * across a remount.
 */
export function disclosureKey(chatId: string, messageId: string, entryKey: string): string {
  return `${chatId}:${messageId}:${entryKey}`;
}

/**
 * A plain record, replaced on every write.
 *
 * This was a `$state(new Map())` and clicking a row did nothing: a derived that
 * read it through `.get()` never re-ran when `.set()` was called, so the store
 * held the new value while the transcript kept the old one. A record assigned
 * whole is the shape that actually invalidates, and it costs one object copy
 * per click. Keys are `chat:message:entry`, so insertion order survives and the
 * oldest can still be dropped first.
 */
/** Exported so a test can build its own instance; the app uses `disclosure`. */
export class DisclosureStore {
  #open = $state<Record<string, boolean>>({});
  #max: number;

  /** `max` is a parameter so a test can cross the bound without 2000 rows. */
  constructor(max: number = MAX_ENTRIES) {
    this.#max = max;
  }

  /** What the reader chose for `key`, or the caller's default if they never did. */
  isOpen(key: string, fallback: boolean): boolean {
    return this.#open[key] ?? fallback;
  }

  set(key: string, open: boolean): void {
    const next = { ...this.#open, [key]: open };
    const keys = Object.keys(next);
    if (keys.length > this.#max) {
      for (const oldest of keys.slice(0, keys.length - this.#max)) delete next[oldest];
    }
    this.#open = next;
  }

  toggle(key: string, fallback: boolean): void {
    this.set(key, !this.isOpen(key, fallback));
  }

  /** Forget one conversation (its chat was deleted). */
  forget(chatId: string): void {
    const prefix = `${chatId}:`;
    const next = { ...this.#open };
    for (const key of Object.keys(next)) {
      if (key.startsWith(prefix)) delete next[key];
    }
    this.#open = next;
  }

  /** Test seam: the app never needs to drop every reader choice at once. */
  clear(): void {
    this.#open = {};
  }
}

export const disclosure = new DisclosureStore();

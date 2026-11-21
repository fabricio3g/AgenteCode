/**
 * A plain copy of reactive state, for IPC.
 *
 * `$state.snapshot` strips Svelte's proxies but shares strings, so a 12 MB
 * transcript costs a walk over its objects instead of the JSON round trip's
 * two full copies of every byte. Structured clone (IPC) then rejects anything
 * that is not plain data — a function, a DOM node — and `toIpc` falls back to
 * the old JSON round trip for exactly that case, which drops such values.
 */
function plain<T>(value: T): T {
  return $state.snapshot(value) as T;
}

function isCloneError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /DataCloneError|could not be cloned/i.test(text);
}

/** Send through `send` as a snapshot; on a clone error, retry once as JSON. */
export async function toIpc<T, R>(value: T, send: (payload: T) => Promise<R>): Promise<R> {
  try {
    return await send(plain(value));
  } catch (error) {
    if (!isCloneError(error)) throw error;
    return send(JSON.parse(JSON.stringify(value)) as T);
  }
}

/**
 * Merge a persisted list into an in-memory one by id.
 *
 * Libraries load once at startup; a save that lands while that query is in
 * flight must not be dropped when the result arrives. When both sides know an
 * entry, the newer `updatedAt` wins.
 */
export function mergeById<T extends { id: string; updatedAt?: number }>(current: T[], incoming: T[]): T[] {
  const byId = new Map<string, T>();
  for (const entry of incoming) byId.set(entry.id, entry);
  for (const entry of current) {
    const existing = byId.get(entry.id);
    if (!existing || (entry.updatedAt || 0) > (existing.updatedAt || 0)) {
      byId.set(entry.id, entry);
    }
  }
  return [...byId.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

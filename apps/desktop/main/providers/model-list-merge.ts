// A provider's picker list: what its `/models` serves, plus the models.dev
// rows the core lets a picker add (`models.catalog` → `catalog_extras`): none
// for providers whose own list decides membership, never a deprecated one —
// so a model the provider retires leaves every picker, the TUI's included.
// Live entries come first; the rest follow, marked as not listed.

export type CatalogEntry = { id: string; name?: string; status?: string };

export type ListedModel = {
  id: string;
  name: string;
  /** `live`: in the provider's own list. `catalog`: models.dev lists it, the
      provider did not. */
  availability: 'live' | 'catalog';
};

const bare = (id: string) => id.slice(id.lastIndexOf('/') + 1);

export function mergeModelLists(live: string[], catalog: CatalogEntry[]): ListedModel[] {
  const liveIds = new Set(live.map(bare));
  const listed: ListedModel[] = [...new Set(live)].sort().map((id) => ({ id, name: id, availability: 'live' }));
  const extra = catalog
    .filter((entry) => entry.id && entry.status !== 'deprecated' && !liveIds.has(bare(entry.id)))
    // Ids, like the live rows: one list should not mix two naming schemes.
    .map((entry): ListedModel => ({ id: entry.id, name: entry.id, availability: 'catalog' }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return [...listed, ...extra];
}

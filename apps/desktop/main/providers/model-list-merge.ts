// A provider's picker list: what its `/models` serves, plus what models.dev
// records for it. Providers drop a model from `/models` the day it is retired
// (and some never list everything they serve), so the live list alone hid
// models people were still using. Live entries come first; the rest follow,
// marked so the picker can say where they came from.

export type CatalogEntry = { id: string; name?: string; status?: string };

export type ListedModel = {
  id: string;
  name: string;
  /** `live`: in the provider's own list. `catalog`: models.dev lists it, the
      provider did not. `retired`: models.dev marks it deprecated. */
  availability: 'live' | 'catalog' | 'retired';
};

const bare = (id: string) => id.slice(id.lastIndexOf('/') + 1);

export function mergeModelLists(live: string[], catalog: CatalogEntry[]): ListedModel[] {
  const liveIds = new Set(live.map(bare));
  const listed: ListedModel[] = [...new Set(live)].sort().map((id) => ({ id, name: id, availability: 'live' }));
  const extra = catalog
    .filter((entry) => entry.id && !liveIds.has(bare(entry.id)))
    .map((entry): ListedModel => ({
      id: entry.id,
      // Ids, like the live rows: one list should not mix two naming schemes.
      name: entry.id,
      availability: entry.status === 'deprecated' ? 'retired' : 'catalog'
    }))
    .sort((a, b) => Number(a.availability === 'retired') - Number(b.availability === 'retired') || a.id.localeCompare(b.id));
  return [...listed, ...extra];
}

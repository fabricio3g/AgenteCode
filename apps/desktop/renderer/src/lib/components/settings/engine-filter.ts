/**
 * The engine pool's filter in Settings → Search: what a query matches, the
 * On / Needs setup views, and which group each engine is listed under.
 */
import type { AggregatorCatalogItem } from '$lib/services/search';

export type EngineView = 'all' | 'on' | 'setup';

export type EngineGroupId = 'recommended' | 'general' | 'research' | 'configured' | 'other';

/** Lower case without accents, so "cafe" finds "Café". */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * Everything a person might type to find an engine: its name and id, what
 * it searches (the description: "papers", "videos", "programming"), and how
 * it is reached ("self hosted", "api key", "url", "beta").
 */
export function engineSearchText(item: AggregatorCatalogItem): string {
  const words = [
    item.label,
    item.id.replaceAll('_', ' '),
    item.description || '',
    item.category.replaceAll('_', ' '),
    item.stability,
    item.requires.includes('api_key') ? 'api key' : '',
    item.requires.includes('base_url') ? 'url self hosted' : '',
    item.supports_safe_search ? 'safe search' : '',
  ];
  return fold(words.join(' '));
}

/** Every word of the query appears somewhere in the engine's text. */
export function matchesEngine(item: AggregatorCatalogItem, query: string): boolean {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const text = engineSearchText(item);
  return terms.every((term) => text.includes(term));
}

/** Name hits first (start of the name, then a word in it), then the rest. */
function rank(item: AggregatorCatalogItem, query: string): number {
  const needle = fold(query.trim());
  if (!needle) return 0;
  const label = fold(item.label);
  if (label.startsWith(needle)) return 0;
  if (label.split(/[\s_-]+/).some((word) => word.startsWith(needle))) return 1;
  return 2;
}

export function filterEngines(
  items: AggregatorCatalogItem[],
  { query, view, enabled, needsSetup }: {
    query: string;
    view: EngineView;
    enabled: ReadonlySet<string>;
    needsSetup: (item: AggregatorCatalogItem) => boolean;
  },
): AggregatorCatalogItem[] {
  return items
    .filter((item) => view !== 'on' || enabled.has(item.id))
    .filter((item) => view !== 'setup' || needsSetup(item))
    .filter((item) => matchesEngine(item, query))
    .map((item, index) => ({ item, index, rank: rank(item, query) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ item }) => item);
}

/** The one group an engine is listed under; every engine has exactly one. */
export function engineGroup(item: AggregatorCatalogItem): EngineGroupId {
  if (item.recommended) return 'recommended';
  if (item.category === 'general') return 'general';
  if (item.category === 'research') return 'research';
  if (item.category === 'self_hosted' || item.category === 'api') return 'configured';
  return 'other';
}

export const ENGINE_GROUP_ORDER: EngineGroupId[] = ['recommended', 'general', 'research', 'configured', 'other'];

import { describe, expect, it } from 'vitest';
import type { AggregatorCatalogItem } from '$lib/services/search';
import { ENGINE_GROUP_ORDER, engineGroup, filterEngines, matchesEngine } from './engine-filter';

const engine = (overrides: Partial<AggregatorCatalogItem>): AggregatorCatalogItem => ({
  id: 'x', label: 'X', category: 'general', transport: 'json', stability: 'stable', requires: [],
  supports_safe_search: false, timeout_ms: 5000, recommended: false, ...overrides,
});

const catalog = [
  engine({ id: 'wikipedia', label: 'Wikipedia', category: 'recommended', recommended: true, description: 'Encyclopedia articles (Wikimedia API).' }),
  engine({ id: 'arxiv', label: 'arXiv', category: 'recommended', recommended: true, description: 'Preprints (arXiv API; metadata CC0).' }),
  engine({ id: 'sepiasearch', label: 'Sepia Search', description: 'PeerTube videos (public API).', supports_safe_search: true }),
  engine({ id: 'semantic_scholar', label: 'Semantic Scholar', category: 'research', description: 'Papers with abstracts.' }),
  engine({ id: 'searxng', label: 'SearXNG', category: 'self_hosted', requires: ['base_url'] }),
  engine({ id: 'kagi', label: 'Kagi', category: 'api', requires: ['api_key'] }),
  engine({ id: 'fourget', label: '4get', category: 'self_hosted', stability: 'beta', requires: ['base_url'] }),
];

const run = (query: string, view: 'all' | 'on' | 'setup' = 'all', enabled = new Set<string>()) =>
  filterEngines(catalog, { query, view, enabled, needsSetup: (item) => item.requires.length > 0 }).map((item) => item.id);

describe('engine pool filter', () => {
  it('finds engines by what they search, not only by name', () => {
    expect(run('videos')).toEqual(['sepiasearch']);
    expect(run('papers')).toEqual(['semantic_scholar']);
    expect(run('encyclopedia')).toEqual(['wikipedia']);
  });

  it('needs every word, ignores case and accents', () => {
    expect(run('semantic papers')).toEqual(['semantic_scholar']);
    expect(run('semantic videos')).toEqual([]);
    expect(matchesEngine(catalog[0], 'WIKIPÉDIA')).toBe(true);
  });

  it('understands how an engine is reached', () => {
    expect(run('api key')).toEqual(['kagi']);
    expect(run('self hosted')).toEqual(['searxng', 'fourget']);
    expect(run('beta')).toEqual(['fourget']);
    expect(run('safe search')).toEqual(['sepiasearch']);
  });

  it('puts name matches before description matches', () => {
    expect(run('ar')[0]).toBe('arxiv');
  });

  it('narrows to engines that are on or still need setup', () => {
    expect(run('', 'on', new Set(['arxiv', 'kagi']))).toEqual(['arxiv', 'kagi']);
    expect(run('', 'setup')).toEqual(['searxng', 'kagi', 'fourget']);
    expect(run('kagi', 'on', new Set(['arxiv']))).toEqual([]);
  });

  it('lists each engine under exactly one group', () => {
    const seen = catalog.map(engineGroup);
    expect(seen.every((group) => ENGINE_GROUP_ORDER.includes(group))).toBe(true);
    expect(engineGroup(catalog[1])).toBe('recommended');
    expect(engineGroup(engine({ category: 'experimental' }))).toBe('other');
  });
});

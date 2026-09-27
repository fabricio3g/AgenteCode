export type AggregatorEngineCategory = 'recommended' | 'general' | 'research' | 'self_hosted' | 'api';
export type AggregatorEngineTransport = 'json' | 'xml';
export type AggregatorEngineStability = 'stable' | 'beta' | 'experimental';
export type AggregatorRequirement = 'api_key' | 'base_url';

/*
 * Every engine here is reached through an interface its operator offers for
 * programmatic use: an official API, a documented JSON endpoint, or a server
 * the user runs themselves. Scraping search-engine result pages is against
 * those engines' terms, so there are no HTML scrapers in this catalog.
 */
export type AggregatorEngineId =
  | 'wikipedia' | 'wiby' | 'sepiasearch'
  | 'arxiv' | 'openalex' | 'crossref' | 'pubmed' | 'semantic_scholar' | 'stackexchange' | 'hackernews'
  | 'searxng' | 'yacy' | 'fourget'
  | 'kagi' | 'firecrawl' | 'linkup' | 'ollama_web' | 'perplexity_search';

export interface AggregatorEngineDefinition {
  id: AggregatorEngineId;
  label: string;
  category: AggregatorEngineCategory;
  transport: AggregatorEngineTransport;
  stability: AggregatorEngineStability;
  requires: AggregatorRequirement[];
  supports_safe_search: boolean;
  timeout_ms: number;
  recommended: boolean;
  default_base_url?: string;
  description?: string;
}

const engine = (
  id: AggregatorEngineId,
  label: string,
  category: AggregatorEngineCategory,
  transport: AggregatorEngineTransport,
  stability: AggregatorEngineStability,
  extra: Partial<AggregatorEngineDefinition> = {},
): AggregatorEngineDefinition => ({
  id, label, category, transport, stability,
  requires: [],
  supports_safe_search: false,
  timeout_ms: 7000,
  recommended: false,
  ...extra,
});

export const AGGREGATOR_ENGINE_CATALOG: AggregatorEngineDefinition[] = [
  engine('wikipedia', 'Wikipedia', 'recommended', 'json', 'stable', { recommended: true, description: 'Encyclopedia articles (Wikimedia API).' }),
  engine('wiby', 'Wiby', 'general', 'json', 'stable', { description: 'Independent small-web index (public JSON API).' }),
  engine('arxiv', 'arXiv', 'recommended', 'xml', 'stable', { recommended: true, description: 'Preprints (arXiv API; metadata CC0).' }),
  engine('crossref', 'Crossref', 'recommended', 'json', 'stable', { recommended: true, description: 'Scholarly works metadata (Crossref REST API).' }),
  engine('semantic_scholar', 'Semantic Scholar', 'research', 'json', 'stable', { description: 'Papers with abstracts (Semantic Scholar API, ODC-BY). Heavily rate-limited without a key.' }),
  engine('pubmed', 'PubMed', 'recommended', 'json', 'stable', { recommended: true, description: 'Biomedical literature (NCBI E-utilities).' }),

  engine('sepiasearch', 'Sepia Search', 'general', 'json', 'stable', { supports_safe_search: true, description: 'PeerTube videos (public API).' }),

  engine('openalex', 'OpenAlex', 'research', 'json', 'stable', { description: 'Scholarly works (OpenAlex API; about 100 free calls a day without a key).' }),
  engine('stackexchange', 'Stack Exchange', 'research', 'json', 'stable', { description: 'Programming Q&A (Stack Exchange API).' }),
  engine('hackernews', 'Hacker News', 'research', 'json', 'stable', { description: 'Tech news and discussion (Algolia HN API).' }),

  engine('searxng', 'SearXNG', 'self_hosted', 'json', 'stable', { requires: ['base_url'], supports_safe_search: true }),
  engine('yacy', 'YaCy', 'self_hosted', 'json', 'stable', { requires: ['base_url'], default_base_url: 'http://localhost:8090' }),
  engine('fourget', '4get', 'self_hosted', 'json', 'beta', { requires: ['base_url'] }),

  engine('kagi', 'Kagi', 'api', 'json', 'stable', { requires: ['api_key'], default_base_url: 'https://kagi.com/api/v1' }),
  engine('firecrawl', 'Firecrawl Search', 'api', 'json', 'stable', { requires: ['api_key'], default_base_url: 'https://api.firecrawl.dev/v2' }),
  engine('linkup', 'Linkup', 'api', 'json', 'beta', { requires: ['api_key'], default_base_url: 'https://api.linkup.so/v1' }),
  engine('ollama_web', 'Ollama Web Search', 'api', 'json', 'beta', { requires: ['api_key'], default_base_url: 'https://ollama.com/api' }),
  engine('perplexity_search', 'Perplexity Search', 'api', 'json', 'beta', { requires: ['api_key'], default_base_url: 'https://api.perplexity.ai' }),
];

export const DEFAULT_AGGREGATOR_ENGINES: AggregatorEngineId[] =
  AGGREGATOR_ENGINE_CATALOG.filter((item) => item.recommended).map((item) => item.id);

export const SUPPORTED_AGGREGATOR_ENGINES: AggregatorEngineId[] =
  AGGREGATOR_ENGINE_CATALOG.map((item) => item.id);

/** Identifies the app and how to reach its maintainers, as Wikimedia and Crossref ask. */
export const AGGREGATOR_USER_AGENT = 'FlaxeoChat/1.0 (+https://github.com/fabricio3g/Flaxeo-Chat)';
export const AGGREGATOR_CONCURRENCY = 4;
export const AGGREGATOR_DEADLINE_MS = 12_000;
export const AGGREGATOR_FAILURE_THRESHOLD = 3;
export const AGGREGATOR_COOLDOWN_MS = 10 * 60 * 1000;

export type AggregatorEngineCategory = 'recommended' | 'general' | 'research' | 'self_hosted' | 'api' | 'experimental';
export type AggregatorEngineTransport = 'json' | 'html' | 'xml';
export type AggregatorEngineStability = 'stable' | 'beta' | 'experimental';
export type AggregatorRequirement = 'api_key' | 'base_url';

export type AggregatorEngineId =
  | 'duckduckgo' | 'wikipedia' | 'wiby' | 'mojeek'
  | 'qwant' | 'sepiasearch' | 'bing' | 'brave' | 'startpage' | 'yahoo' | 'librex'
  | 'yep' | 'mwmbl' | 'marginalia' | 'yandex' | 'baidu' | 'google' | 'ghostery'
  | 'searxng' | 'yacy' | 'fourget' | 'openserp'
  | 'kagi' | 'firecrawl' | 'searchapi' | 'linkup' | 'ollama_web' | 'perplexity_search'
  | 'arxiv' | 'openalex' | 'crossref' | 'stackexchange' | 'hackernews';

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
  timeout_ms: transport === 'html' ? 8000 : 7000,
  recommended: false,
  ...extra,
});

export const AGGREGATOR_ENGINE_CATALOG: AggregatorEngineDefinition[] = [
  engine('duckduckgo', 'DuckDuckGo', 'recommended', 'html', 'stable', { recommended: true, supports_safe_search: true }),
  engine('wikipedia', 'Wikipedia', 'recommended', 'json', 'stable', { recommended: true }),
  engine('wiby', 'Wiby', 'recommended', 'json', 'stable', { recommended: true, description: 'Independent small-web index.' }),
  engine('mojeek', 'Mojeek', 'recommended', 'html', 'stable', { recommended: true, supports_safe_search: true }),

  engine('qwant', 'Qwant', 'general', 'json', 'beta', { supports_safe_search: true }),
  engine('sepiasearch', 'Sepia Search', 'general', 'json', 'stable', { supports_safe_search: true }),
  engine('bing', 'Bing Web', 'general', 'html', 'beta'),
  engine('brave', 'Brave Web', 'general', 'html', 'beta', { supports_safe_search: true }),
  engine('startpage', 'Startpage', 'general', 'html', 'beta'),
  engine('yahoo', 'Yahoo', 'general', 'html', 'beta'),
  engine('yep', 'Yep', 'general', 'html', 'experimental'),
  engine('mwmbl', 'Mwmbl', 'general', 'html', 'experimental'),
  engine('marginalia', 'Marginalia', 'general', 'html', 'experimental'),
  engine('ghostery', 'Ghostery Search', 'general', 'html', 'experimental'),

  engine('arxiv', 'arXiv', 'research', 'xml', 'stable'),
  engine('openalex', 'OpenAlex', 'research', 'json', 'stable'),
  engine('crossref', 'Crossref', 'research', 'json', 'stable'),
  engine('stackexchange', 'Stack Exchange', 'research', 'json', 'stable'),
  engine('hackernews', 'Hacker News', 'research', 'json', 'stable'),

  engine('searxng', 'SearXNG', 'self_hosted', 'json', 'stable', { requires: ['base_url'], supports_safe_search: true }),
  engine('yacy', 'YaCy', 'self_hosted', 'json', 'stable', { requires: ['base_url'], default_base_url: 'http://localhost:8090' }),
  engine('fourget', '4get', 'self_hosted', 'json', 'beta', { requires: ['base_url'] }),
  engine('openserp', 'OpenSERP', 'self_hosted', 'json', 'beta', { requires: ['base_url'] }),

  engine('kagi', 'Kagi', 'api', 'json', 'stable', { requires: ['api_key'], default_base_url: 'https://kagi.com/api/v1' }),
  engine('firecrawl', 'Firecrawl Search', 'api', 'json', 'stable', { requires: ['api_key'], default_base_url: 'https://api.firecrawl.dev/v2' }),
  engine('searchapi', 'SearchApi.io', 'api', 'json', 'stable', { requires: ['api_key'], default_base_url: 'https://www.searchapi.io/api/v1' }),
  engine('linkup', 'Linkup', 'api', 'json', 'beta', { requires: ['api_key'], default_base_url: 'https://api.linkup.so/v1' }),
  engine('ollama_web', 'Ollama Web Search', 'api', 'json', 'beta', { requires: ['api_key'], default_base_url: 'https://ollama.com/api' }),
  engine('perplexity_search', 'Perplexity Search', 'api', 'json', 'beta', { requires: ['api_key'], default_base_url: 'https://api.perplexity.ai' }),

  engine('librex', 'LibreX', 'experimental', 'html', 'experimental'),
  engine('yandex', 'Yandex', 'experimental', 'html', 'experimental'),
  engine('baidu', 'Baidu', 'experimental', 'html', 'experimental'),
  engine('google', 'Google Web', 'experimental', 'html', 'experimental', { supports_safe_search: true }),
];

export const DEFAULT_AGGREGATOR_ENGINES: AggregatorEngineId[] =
  AGGREGATOR_ENGINE_CATALOG.filter((item) => item.recommended).map((item) => item.id);

export const SUPPORTED_AGGREGATOR_ENGINES: AggregatorEngineId[] =
  AGGREGATOR_ENGINE_CATALOG.map((item) => item.id);

export const AGGREGATOR_USER_AGENT = 'Flaxeo/1.0 (local search aggregator)';
export const AGGREGATOR_CONCURRENCY = 4;
export const AGGREGATOR_DEADLINE_MS = 12_000;
export const AGGREGATOR_FAILURE_THRESHOLD = 3;
export const AGGREGATOR_COOLDOWN_MS = 10 * 60 * 1000;

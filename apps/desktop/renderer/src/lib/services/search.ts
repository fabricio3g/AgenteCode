import type { SearchOptions, SearchResponse } from '$lib/types/bridge';
import { invoke } from './bridge';
import { loadAppConfig } from '$lib/utils/storage';
import { getStoredHfToken } from './huggingface';

export interface AggregatorCatalogItem {
  id: string;
  label: string;
  category: 'recommended' | 'general' | 'research' | 'self_hosted' | 'api' | 'experimental';
  transport: 'json' | 'html' | 'xml';
  stability: 'stable' | 'beta' | 'experimental';
  requires: Array<'api_key' | 'base_url'>;
  supports_safe_search: boolean;
  timeout_ms: number;
  recommended: boolean;
  default_base_url?: string;
  description?: string;
}

export interface AggregatorProbeResult {
  engine_attempts: Array<{
    engine: string;
    success: boolean;
    result_count: number;
    latency_ms: number;
    error?: string;
    missing?: string[];
    cooldown_until?: string;
    skipped?: boolean;
  }>;
  elapsed_ms: number;
  deadline_reached: boolean;
  enabled_engines: string[];
}

export function getAggregatorCatalog(): Promise<AggregatorCatalogItem[]> {
  return invoke<AggregatorCatalogItem[]>('search:get-catalog');
}

export function probeAggregatorEngines(engineIds: string[], options: SearchOptions, query?: string): Promise<AggregatorProbeResult> {
  return invoke<AggregatorProbeResult>('search:probe-engines', { engine_ids: engineIds, options, query });
}

function resolveSearchOptions(explicit?: SearchOptions): SearchOptions | undefined {
  if (explicit) return explicit;
  return undefined;
}

function flattenAggregatorProviderOptions(providers: Record<string, Record<string, unknown>>): SearchOptions {
  const flattened: SearchOptions = {};
  for (const [id, config] of Object.entries(providers)) {
    if (config?.api_key) flattened[`${id}_api_key`] = config.api_key;
    if (config?.base_url) flattened[`${id}_base_url`] = config.base_url;
  }
  return flattened;
}

export async function webSearch(args: {
  query: string;
  context?: string;
  deep?: boolean;
  mode?: string;
  options?: SearchOptions;
}): Promise<SearchResponse> {
  const stored = await loadAppConfig();
  const searchProviders = stored.search?.providers || {};
  return invoke<SearchResponse>('web_search', {
    query: args.query,
    context: args.context,
    deep: args.deep ?? false,
    mode: args.mode,
    options: {
      max_results: stored.search?.max_results,
      provider: stored.search?.provider || 'aggregator',
      aggregator_engines: stored.search?.aggregator_engines,
      safe_search: stored.search?.safe_search,
      brave_api_key: searchProviders.brave?.api_key,
      tavily_api_key: searchProviders.tavily?.api_key,
      exa_api_key: searchProviders.exa?.api_key,
      searxng_base_url: searchProviders.searxng?.base_url,
      jina_api_key: searchProviders.jina?.api_key,
      jina_base_url: searchProviders.jina?.base_url,
      youcom_api_key: searchProviders.youcom?.api_key,
      perplexity_api_key: searchProviders.perplexity?.api_key,
      perplexity_model: searchProviders.perplexity?.model,
      perplexity_api_url: searchProviders.perplexity?.api_url,
      ...flattenAggregatorProviderOptions(searchProviders as Record<string, Record<string, unknown>>),
      conversation_context: args.context,
      ...resolveSearchOptions(args.options)
    }
  });
}

async function ingestSearchContext(chatId: string, context: string, sources: Array<{ title: string; url: string; snippet: string }>): Promise<number> {
  const normalizedChatId = String(chatId || '').trim();
  if (!normalizedChatId) throw new Error('chatId is required');
  return invoke<number>('ingest_search_context', {
    chatId: normalizedChatId,
    context,
    sources
  });
}

export async function fetchModelCatalog(): Promise<unknown> {
  return invoke<unknown>('fetch_model_catalog');
}

export async function searchHfModels(query: string, sort = 'trending', limit = 20): Promise<unknown> {
  return invoke<unknown>('search_hf_models', { query, sort, limit, hfToken: getStoredHfToken() });
}

export interface HfModelSearchItem {
  /** SPDX-ish id from the repo tags, e.g. apache-2.0. */
  license?: string;
  repo_id: string;
  label?: string;
  author?: string;
  downloads?: number;
  likes?: number;
  lastModified?: string;
  size_label?: string;
  gated?: boolean | string;
  tags?: string[];
  [key: string]: unknown;
}

export interface HfModelSearchPage {
  items: HfModelSearchItem[];
  nextCursor: string | null;
  error?: string;
  errorCode?: 'authentication' | 'rate_limit' | 'network' | 'malformed';
}

export interface HfGgufFile {
  filename: string;
  size?: number;
  size_human?: string;
  quantization?: string;
  is_projector?: boolean;
}

export interface HfRepoGgufResponse {
  repo_id: string;
  model_id?: string;
  gguf_files: HfGgufFile[];
  files: HfGgufFile[];
  projector_files?: HfGgufFile[];
  gated?: boolean | string;
  license?: string;
  error?: string;
}

export async function searchHfModelsPage(
  query: string,
  sort = 'trending',
  limit = 20,
  cursor?: string | null,
): Promise<HfModelSearchPage> {
  const payload = await invoke<unknown>('search_hf_models', {
    query,
    sort,
    limit,
    cursor,
    paged: true,
    hfToken: getStoredHfToken(),
  });
  if (Array.isArray(payload)) return { items: payload as HfModelSearchItem[], nextCursor: null };
  const page = payload as Partial<HfModelSearchPage> | null;
  return {
    items: Array.isArray(page?.items) ? page.items : [],
    nextCursor: typeof page?.nextCursor === 'string' ? page.nextCursor : null,
    error: page?.error,
    errorCode: page?.errorCode,
  };
}

export async function hfRepoGguf(repo_id: string): Promise<HfRepoGgufResponse | null> {
  return invoke<HfRepoGgufResponse | null>('hf_repo_gguf', { repoId: repo_id, hfToken: getStoredHfToken() });
}

export interface HfReadmeResponse {
  repo_id: string;
  readme: string;
  error?: string;
}

export async function fetchHfReadme(repo_id: string): Promise<HfReadmeResponse> {
  try {
    const payload = await invoke<HfReadmeResponse>('fetch_hf_readme', { repoId: repo_id, hfToken: getStoredHfToken() });
    if (payload && typeof payload.readme === 'string') return { ...payload, readme: stripFrontmatter(payload.readme) };
    return { repo_id, readme: '' };
  } catch {
    return { repo_id, readme: '' };
  }
}

/** Drop YAML frontmatter (`---` block) so cards show prose, not metadata. */
export function stripFrontmatter(text: string): string {
  return String(text || '').replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '').trimStart();
}

async function openUrlWindow(url: string): Promise<void> {
  await invoke<void>('open_url_window', { url });
}

export interface OpenWebviewerResult {
  success?: boolean;
  error?: string;
}

export async function openWebviewer(url: string, title?: string): Promise<OpenWebviewerResult> {
  return invoke<OpenWebviewerResult>('open_webviewer', { url, title });
}

export interface FetchUrlResult {
  url: string;
  title?: string;
  excerpt?: string;
  content: string;
  links?: Array<{ text: string; url: string; domain: string; sameSite: boolean }>;
  site_name?: string;
  og_image?: string;
  file_type?: string;
  length?: number;
  status: number;
  error?: string;
  truncated?: boolean;
  warning?: string;
  quality?: 'ok' | 'thin_content' | 'blocked';
}

export async function fetchUrlContent(url: string, maxBytes?: number): Promise<FetchUrlResult> {
  return invoke<FetchUrlResult>('fetch_url_content', { url, maxBytes });
}

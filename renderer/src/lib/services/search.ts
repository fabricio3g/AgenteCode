import type { SearchOptions, SearchResponse } from '$lib/types/tauri';
import { invoke } from './tauri';
import { loadAppConfig } from '$lib/utils/storage';

function resolveSearchOptions(explicit?: SearchOptions): SearchOptions | undefined {
  if (explicit) return explicit;
  return undefined;
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
      context_budget_chars: stored.search?.context_budget_chars,
      provider: stored.search?.provider || 'aggregator',
      aggregator_engines: stored.search?.aggregator_engines,
      safe_search: stored.search?.safe_search,
      google_cse_api_key: searchProviders.google_cse?.api_key,
      google_cse_id: searchProviders.google_cse?.engine_id,
      brave_api_key: searchProviders.brave?.api_key,
      serpapi_api_key: searchProviders.serpapi?.api_key,
      tavily_api_key: searchProviders.tavily?.api_key,
      exa_api_key: searchProviders.exa?.api_key,
      searxng_base_url: searchProviders.searxng?.base_url,
      bing_api_key: searchProviders.bing?.api_key,
      bing_endpoint: searchProviders.bing?.endpoint,
      serper_api_key: searchProviders.serper?.api_key,
      jina_api_key: searchProviders.jina?.api_key,
      jina_base_url: searchProviders.jina?.base_url,
      youcom_api_key: searchProviders.youcom?.api_key,
      perplexity_api_key: searchProviders.perplexity?.api_key,
      perplexity_model: searchProviders.perplexity?.model,
      perplexity_api_url: searchProviders.perplexity?.api_url,
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
  return invoke<unknown>('search_hf_models', { query, sort, limit });
}

export async function hfRepoGguf(repo_id: string): Promise<unknown> {
  return invoke<unknown>('hf_repo_gguf', { repoId: repo_id });
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

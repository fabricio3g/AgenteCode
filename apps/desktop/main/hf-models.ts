import { LOCAL_GGUF_CATALOG, TTS_MODEL_CATALOG, WHISPER_QUALITY_CATALOG } from './config.ts';
import { EMBEDDING_MODEL_CATALOG } from './rag/embedding-catalog.ts';
import { fetchWithRetry } from './search-providers/shared.ts';

export async function fetchModelCatalog() {
  return {
    llm: LOCAL_GGUF_CATALOG,
    tts: TTS_MODEL_CATALOG,
    whisper: WHISPER_QUALITY_CATALOG,
    embeddings: EMBEDDING_MODEL_CATALOG
  };
}

function hfHeaders(hfToken?: string): Record<string, string> | undefined {
  const token = String(hfToken || '').trim();
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

function formatBytes(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function hfFileName(file: { rfilename?: string; path?: string }) {
  return String(file?.rfilename || file?.path || '').trim();
}

function isHfModelGgufFile(file: { rfilename?: string; path?: string }) {
  const filename = hfFileName(file).toLowerCase();
  return filename.endsWith('.gguf') && !filename.includes('mmproj');
}

function hfFileSize(file: { size?: number; lfs?: { size?: number } }) {
  return Number(file?.size || file?.lfs?.size || 0);
}

function normalizeGgufFile(file: { rfilename?: string; path?: string; size?: number; lfs?: { size?: number } }) {
  const filename = hfFileName(file);
  const size = hfFileSize(file);
  return {
    filename,
    name: filename,
    size,
    size_human: formatBytes(size),
  };
}

const HF_REPO_ID_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function isValidHfRepoId(repoId: unknown): repoId is string {
  if (typeof repoId !== 'string' || !HF_REPO_ID_RE.test(repoId)) return false;
  const [owner, name] = repoId.split('/');
  return owner !== '.' && owner !== '..' && name !== '.' && name !== '..';
}

async function fetchHfTreeSizes(repoId: string, hfToken?: string): Promise<Map<string, number>> {
  if (!isValidHfRepoId(repoId)) return new Map();
  try {
    const url = `https://huggingface.co/api/models/${repoId}/tree/main?recursive=true`;
    const resp = await fetchWithRetry(url, { headers: hfHeaders(hfToken), timeout_ms: 15000 });
    if (!resp.ok) return new Map();
    const data = await resp.json() as Array<{ path?: string; size?: number; lfs?: { size?: number } }>;
    if (!Array.isArray(data)) return new Map();
    return new Map(
      data
        .map((item) => [hfFileName(item), hfFileSize(item)] as const)
        .filter(([path, size]) => isHfModelGgufFile({ path }) && size > 0)
    );
  } catch {
    return new Map();
  }
}

function isLikelyLlmHfModel(item: Record<string, unknown>): boolean {
  const repoId = String(item.id || item.modelId || '').toLowerCase();
  const pipeline = String(item.pipeline_tag || '').toLowerCase();
  const tags = Array.isArray(item.tags) ? item.tags.map((tag) => String(tag).toLowerCase()) : [];
  const haystack = `${repoId} ${pipeline} ${tags.join(' ')}`;

  if (pipeline === 'text-generation' || tags.includes('text-generation')) return true;
  return /(llm|llama|qwen|gemma|mistral|mixtral|phi|deepseek|codellama|starcoder|falcon|chatglm|baichuan|internlm|gpt-?oss|gpt-?neo|tinyllama|vicuna|dolphin|orca|hermes|openchat)/i.test(haystack);
}

function normalizeHfModel(item: Record<string, unknown>): Record<string, unknown> {
  const repoId = String(item.id || item.modelId || '').trim();
  const siblings = Array.isArray(item.siblings) ? item.siblings as Array<{ rfilename?: string; size?: number; lfs?: { size?: number } }> : [];
  const ggufFiles = siblings.filter(isHfModelGgufFile);
  const normalizedGgufFiles = ggufFiles.map(normalizeGgufFile);
  const largest = normalizedGgufFiles.reduce((max, file) => Math.max(max, Number(file.size || 0)), 0);
  const tags = Array.isArray(item.tags) ? item.tags.map(String) : [];
  const name = repoId.split('/').pop() || repoId;
  const sizeMatch = name.match(/(?:^|[-_])([0-9]+(?:\.[0-9]+)?\s*[bB])(?:[-_]|$)/);

  const cardLicense = (item.cardData as { license?: unknown } | undefined)?.license;
  const license = String(tags.find((tag) => tag.startsWith('license:'))?.slice(8) || (typeof cardLicense === 'string' ? cardLicense : '') || '');

  return {
    ...item,
    repo_id: repoId,
    label: name,
    license,
    author: repoId.split('/')[0] || 'Hugging Face',
    size_label: sizeMatch ? sizeMatch[1].replace(/\s+/g, '').toUpperCase() : undefined,
    has_vision: /vision|vl|mmproj/i.test(`${repoId} ${tags.join(' ')}`),
    has_tools: /tool|function/i.test(tags.join(' ')),
    downloads: Number(item.downloads || 0),
    likes: Number(item.likes || 0),
    gguf_files_count: ggufFiles.length || undefined,
    gguf_files: normalizedGgufFiles,
    files: normalizedGgufFiles,
    largest_gguf_human: largest ? formatBytes(largest) : undefined,
  };
}

export async function searchHfModels(
  query: string,
  sort = 'trending',
  limit = 20,
  hfToken?: string,
  cursor?: string,
  paged = false,
) {
  try {
    const params = new URLSearchParams({
      search: query,
      sort,
      limit: String(limit),
      full: 'true',
      blobs: 'true',
    });
    params.append('filter', 'gguf');
    params.append('filter', 'text-generation');
    const requestedCursor = String(cursor || '');
    const url = requestedCursor.startsWith('https://huggingface.co/api/models?')
      ? requestedCursor
      : `https://huggingface.co/api/models?${params.toString()}`;
    const resp = await fetchWithRetry(url, { headers: hfHeaders(hfToken), timeout_ms: 15000 });
    if (!resp.ok) {
      if (!paged) return [];
      const errorCode = resp.status === 401 || resp.status === 403
        ? 'authentication'
        : resp.status === 429 ? 'rate_limit' : 'network';
      const error = errorCode === 'authentication'
        ? 'This repository or search requires a valid Hugging Face token.'
        : errorCode === 'rate_limit'
          ? 'Hugging Face rate limit reached. Wait a moment and try again.'
          : `Hugging Face search failed (${resp.status}).`;
      return { items: [], nextCursor: null, error, errorCode };
    }
    const data = await resp.json();
    const items = Array.isArray(data)
      ? data.filter((item) => isLikelyLlmHfModel(item as Record<string, unknown>)).map((item) => normalizeHfModel(item as Record<string, unknown>))
      : [];
    if (!paged) return items;
    const link = resp.headers.get('link') || '';
    const nextCursor = link
      .split(',')
      .map((part) => part.trim())
      .find((part) => /rel="?next"?/i.test(part))
      ?.match(/<([^>]+)>/)?.[1] ?? null;
    return { items, nextCursor };
  } catch (error) {
    if (!paged) return [];
    return {
      items: [],
      nextCursor: null,
      error: String((error as Error)?.message || error || 'Hugging Face search failed.'),
      errorCode: 'network',
    };
  }
}

export async function hfRepoGguf(repoId: string, hfToken?: string) {
  if (!isValidHfRepoId(repoId)) return null;
  try {
    const url = `https://huggingface.co/api/models/${repoId}?blobs=true`;
    const resp = await fetchWithRetry(url, { headers: hfHeaders(hfToken), timeout_ms: 15000 });
    if (!resp.ok) return null;
    const data = await resp.json() as Record<string, unknown>;
    const siblings = Array.isArray(data?.siblings) ? data.siblings as Array<{ rfilename?: string; size?: number; lfs?: { size?: number } }> : [];
    let ggufFiles = siblings
      .filter(isHfModelGgufFile)
      .map(normalizeGgufFile);

    if (ggufFiles.some((file) => !file.size)) {
      const treeSizes = await fetchHfTreeSizes(repoId, hfToken);
      ggufFiles = ggufFiles.map((file) => {
        const size = file.size || treeSizes.get(file.filename) || 0;
        return { ...file, size, size_human: formatBytes(size) };
      });
    }
    const projectorFiles = siblings
      .filter((file) => /(?:^|[/_-])mmproj[^/]*\.gguf$/i.test(String(file.rfilename || '')))
      .map(normalizeGgufFile);
    const tags = Array.isArray(data.tags) ? data.tags.map(String) : [];
    return {
      repo_id: repoId,
      model_id: data.modelId as string | undefined,
      gguf_files: ggufFiles,
      files: ggufFiles,
      projector_files: projectorFiles,
      gated: data.gated,
      license: tags.find((tag) => tag.startsWith('license:'))?.slice('license:'.length),
    };
  } catch {
    return null;
  }
}

const HF_README_MAX_CHARS = 40000;

export async function fetchHfReadme(repoId: string, hfToken?: string) {
  try {
    if (!isValidHfRepoId(repoId)) {
      return { repo_id: repoId, readme: '', error: 'Invalid repository id.' };
    }
    const url = `https://huggingface.co/${repoId}/resolve/main/README.md`;
    const resp = await fetchWithRetry(url, { headers: hfHeaders(hfToken), timeout_ms: 15000 });
    if (!resp.ok) return { repo_id: repoId, readme: '' };
    const text = await resp.text();
    const trimmed = text.length > HF_README_MAX_CHARS
      ? text.slice(0, HF_README_MAX_CHARS) + '\n\n… (truncated)'
      : text;
    return { repo_id: repoId, readme: trimmed };
  } catch (error) {
    return { repo_id: repoId, readme: '', error: String((error as Error)?.message || error) };
  }
}

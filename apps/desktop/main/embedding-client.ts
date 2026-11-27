import { createHash } from 'node:crypto';
import { getEmbeddingModelKey, getEmbeddingStatus, setEmbeddingStatus } from './embedding-state.ts';

export const DEFAULT_EMBEDDING_BATCH_SIZE = 32;
export const DEFAULT_EMBEDDING_CONCURRENCY = 2;

const embeddingCache = new Map<string, Float32Array>();
const MAX_CACHE_SIZE = 5000;

function getBaseUrl() {
  const status = getEmbeddingStatus();
  if (status.state === 'ready' && status.port) {
    return `http://127.0.0.1:${status.port}`;
  }
  return null;
}

function cacheKey(text: string, modelKey: string) {
  return createHash('sha256').update(`${modelKey}\0${text}`).digest('hex');
}

function putCache(key: string, vector: Float32Array) {
  if (embeddingCache.size >= MAX_CACHE_SIZE) {
    const firstKey = embeddingCache.keys().next().value;
    if (firstKey) embeddingCache.delete(firstKey);
  }
  embeddingCache.set(key, vector);
}

function getCache(key: string): Float32Array | undefined {
  if (!embeddingCache.has(key)) return undefined;
  const value = embeddingCache.get(key)!;
  embeddingCache.delete(key);
  embeddingCache.set(key, value); // re-insert at end (most recent)
  return value;
}

function recordDimension(vector: Float32Array) {
  const status = getEmbeddingStatus();
  if (!status.dimension) {
    setEmbeddingStatus({ dimension: vector.length });
  }
}

function requestSignal(timeoutMs: number, externalSignal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return externalSignal ? AbortSignal.any([timeout, externalSignal]) : timeout;
}

export interface EmbeddingOptions {
  batchSize?: number;
  concurrency?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  modelId?: string;
}

export async function getEmbedding(text: string, options: EmbeddingOptions = {}): Promise<Float32Array | null> {
  if (!text || !text.trim() || options.signal?.aborted) return null;

  const modelKey = options.modelId ?? getEmbeddingModelKey();
  const key = cacheKey(text, modelKey);
  const cached = getCache(key);
  if (cached) return cached;

  const baseUrl = getBaseUrl();
  if (!baseUrl) return null;

  try {
    const resp = await fetch(`${baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text }),
      signal: requestSignal(options.timeoutMs ?? 10000, options.signal)
    });

    if (!resp.ok) return null;
    const data = await resp.json() as { data?: Array<{ embedding?: number[] }> };
    const embedding = data?.data?.[0]?.embedding;
    if (!embedding || !Array.isArray(embedding) || !embedding.length) return null;
    const vector = new Float32Array(embedding);
    recordDimension(vector);
    putCache(key, vector);
    return vector;
  } catch {
    return null;
  }
}

export async function getEmbeddings(texts: string[], options: EmbeddingOptions = {}): Promise<Array<Float32Array | null>> {
  const results: Array<Float32Array | null> = new Array(texts.length).fill(null);
  if (!texts.length || options.signal?.aborted) return results;

  const baseUrl = getBaseUrl();
  if (!baseUrl) return results;

  const modelKey = options.modelId ?? getEmbeddingModelKey();
  const uncached: Array<{ index: number; text: string; key: string }> = [];
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    const key = cacheKey(text, modelKey);
    const cached = getCache(key);
    if (cached) {
      results[i] = cached;
    } else {
      uncached.push({ index: i, text, key });
    }
  }

  if (uncached.length === 0) return results;

  const batchSize = Math.max(1, Math.floor(Number(options.batchSize) || DEFAULT_EMBEDDING_BATCH_SIZE));
  const concurrency = Math.max(1, Math.floor(Number(options.concurrency) || DEFAULT_EMBEDDING_CONCURRENCY));
  const timeoutMs = Math.max(500, Math.floor(Number(options.timeoutMs) || 30000));

  const batches: Array<Array<{ index: number; text: string; key: string }>> = [];
  for (let i = 0; i < uncached.length; i += batchSize) {
    batches.push(uncached.slice(i, i + batchSize));
  }

  async function fetchBatchWithSplit(batch: Array<{ index: number; text: string; key: string }>): Promise<void> {
    if (!batch.length || options.signal?.aborted) return;
    try {
      const resp = await fetch(`${baseUrl}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: batch.map((entry) => entry.text) }),
        signal: requestSignal(timeoutMs, options.signal)
      });

      if (!resp.ok) {
        if (batch.length > 1 && !options.signal?.aborted) {
          const mid = Math.ceil(batch.length / 2);
          await fetchBatchWithSplit(batch.slice(0, mid));
          await fetchBatchWithSplit(batch.slice(mid));
        }
        return;
      }

      const data = await resp.json() as { data?: Array<{ index?: number; embedding?: number[] }> };
      const embeddings = Array.isArray(data?.data) ? data.data : [];
      for (let j = 0; j < embeddings.length; j++) {
        const entry = embeddings[j];
        const pos = typeof entry?.index === 'number' && Number.isInteger(entry.index) ? entry.index : j;
        if (pos < 0 || pos >= batch.length) continue;
        const emb = entry?.embedding;
        if (!emb || !Array.isArray(emb) || !emb.length) continue;
        const vector = new Float32Array(emb);
        recordDimension(vector);
        const target = batch[pos];
        results[target.index] = vector;
        putCache(target.key, vector);
      }
    } catch {
      if (batch.length > 1 && !options.signal?.aborted) {
        const mid = Math.ceil(batch.length / 2);
        await fetchBatchWithSplit(batch.slice(0, mid));
        await fetchBatchWithSplit(batch.slice(mid));
      }
    }
  }

  let cursor = 0;
  const worker = async () => {
    while (!options.signal?.aborted) {
      const next = cursor++;
      if (next >= batches.length) return;
      await fetchBatchWithSplit(batches[next]);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()));
  return results;
}

export function clearEmbeddingCache() {
  embeddingCache.clear();
}

/**
 * Cosine similarity of two embeddings (0 when either is empty, zero-length
 * or the sizes differ, as after a model change). The crawler's link scorer
 * imports it; without it semantic scoring silently stayed off.
 */
export function cosineSimilarity(left: ArrayLike<number>, right: ArrayLike<number>): number {
  if (!left || !right || left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i += 1) {
    dot += left[i] * right[i];
    leftNorm += left[i] * left[i];
    rightNorm += right[i] * right[i];
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

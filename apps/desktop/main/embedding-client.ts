import { createHash } from 'node:crypto';
import { getEmbeddingStatus } from './embedding-state.ts';

const embeddingCache = new Map();
const MAX_CACHE_SIZE = 5000;

function getBaseUrl() {
  const status = getEmbeddingStatus();
  if (status.state === 'ready' && status.port) {
    return `http://127.0.0.1:${status.port}`;
  }
  return null;
}

function cacheKey(text) {
  return createHash('sha256').update(text).digest('hex');
}

export async function getEmbedding(text) {
  if (!text || !text.trim()) return null;

  const key = cacheKey(text);
  if (embeddingCache.has(key)) {
    const value = embeddingCache.get(key);
    embeddingCache.delete(key);
    embeddingCache.set(key, value); // re-insert at end (most recent)
    return value;
  }

  const baseUrl = getBaseUrl();
  if (!baseUrl) return null;

  try {
    const resp = await fetch(`${baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text }),
      signal: AbortSignal.timeout(10000)
    });

    if (!resp.ok) return null;
    const data = await resp.json();
    const embedding = data?.data?.[0]?.embedding;
    if (!embedding || !Array.isArray(embedding)) return null;
    const vector = new Float32Array(embedding);
    if (embeddingCache.size >= MAX_CACHE_SIZE) {
      const firstKey = embeddingCache.keys().next().value;
      embeddingCache.delete(firstKey);
    }
    embeddingCache.set(key, vector);
    return vector;
  } catch {
    return null;
  }
}

export async function getEmbeddings(texts) {
  const results = new Array(texts.length).fill(null);

  const baseUrl = getBaseUrl();
  if (!baseUrl) return results;

  const uncached = [];
  const uncachedIndices = [];
  for (let i = 0; i < texts.length; i++) {
    const key = cacheKey(texts[i]);
    if (embeddingCache.has(key)) {
      const value = embeddingCache.get(key);
      embeddingCache.delete(key);
      embeddingCache.set(key, value); // re-insert at end (most recent)
      results[i] = value;
    } else {
      uncached.push(texts[i]);
      uncachedIndices.push(i);
    }
  }

  if (uncached.length === 0) return results;

  try {
    const resp = await fetch(`${baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: uncached }),
      signal: AbortSignal.timeout(30000)
    });

    if (!resp.ok) return results;
    const data = await resp.json();
    const embeddings = data?.data || [];
    for (let j = 0; j < embeddings.length; j++) {
      const emb = embeddings[j]?.embedding;
      if (!emb || !Array.isArray(emb)) continue;
      const vector = new Float32Array(emb);
      const idx = uncachedIndices[j];
      results[idx] = vector;
      if (embeddingCache.size >= MAX_CACHE_SIZE) {
        const firstKey = embeddingCache.keys().next().value;
        embeddingCache.delete(firstKey);
      }
      embeddingCache.set(cacheKey(texts[idx]), vector);
    }
  } catch {
    // Best-effort: uncached entries remain null
  }

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

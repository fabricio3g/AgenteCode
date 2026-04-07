const DEFAULT_RERANK_PORT = 11437;

function getRerankUrl() {
  return `http://127.0.0.1:${DEFAULT_RERANK_PORT}`;
}

export async function rerankChunks(query, chunks, topK = 5) {
  if (!query || !chunks || !chunks.length) return chunks;

  try {
    const documents = chunks.map(c => c.text || c);
    const resp = await fetch(`${getRerankUrl()}/v1/rerank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'bge-reranker',
        query,
        documents,
        top_n: Math.min(topK, chunks.length)
      }),
      signal: AbortSignal.timeout(10000)
    });

    if (!resp.ok) return chunks;

    const data = await resp.json();
    if (!Array.isArray(data.results)) return chunks;

    // Sort by relevance score descending
    const ranked = data.results
      .map(r => ({
        ...chunks[r.index],
        rerankScore: r.relevance_score
      }))
      .sort((a, b) => (b.rerankScore || 0) - (a.rerankScore || 0));

    return ranked;
  } catch {
    // Reranker unavailable — return original chunks
    return chunks;
  }
}

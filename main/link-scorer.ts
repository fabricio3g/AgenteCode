const NOISE_DOMAINS = new Set([
  'facebook.com',
  'x.com',
  'twitter.com',
  'instagram.com',
  'linkedin.com',
  'pinterest.com',
  'tiktok.com',
  'youtube.com'
]);

const NOISE_PATH_HINTS = [
  '/login',
  '/signin',
  '/signup',
  '/privacy',
  '/terms',
  '/cookies',
  '/account',
  '/cart',
  '/checkout'
];

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'at', 'by', 'with', 'from',
  'what', 'which', 'who', 'when', 'where', 'why', 'how', 'is', 'are', 'was', 'were', 'be', 'this', 'that'
]);

function normalizeWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function tokenize(text) {
  return normalizeWhitespace(text)
    .toLowerCase()
    .match(/[a-z0-9]+/g)?.filter((term) => !STOPWORDS.has(term)) || [];
}

function extractDomain(url) {
  try {
    return new URL(String(url || '')).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function keywordScore(text, queryTokens) {
  if (!queryTokens.length) return 0;
  const haystack = normalizeWhitespace(text).toLowerCase();
  if (!haystack) return 0;
  let matched = 0;
  let weighted = 0;
  for (const token of queryTokens) {
    if (!token) continue;
    if (haystack.includes(token)) {
      matched += 1;
      const hits = haystack.match(new RegExp(`\\b${token}\\b`, 'g')) || [];
      weighted += 1 + Math.min(hits.length, 3) * 0.2;
    }
  }
  const coverage = matched / Math.max(1, queryTokens.length);
  return (coverage * 0.7) + (weighted / Math.max(1, queryTokens.length) * 0.3);
}

function pathHintBoost(url, queryTokens) {
  const value = String(url || '').toLowerCase();
  if (!value || !queryTokens.length) return 0;
  let boost = 0;
  for (const token of queryTokens.slice(0, 6)) {
    if (value.includes(`/${token}`) || value.includes(`-${token}`) || value.includes(`_${token}`)) {
      boost += 0.08;
    }
  }
  return Math.min(boost, 0.24);
}

function noisePenalty(url) {
  const value = String(url || '').toLowerCase();
  if (!value) return 0;
  const domain = extractDomain(value);
  let penalty = NOISE_DOMAINS.has(domain) ? 0.25 : 0;
  for (const hint of NOISE_PATH_HINTS) {
    if (value.includes(hint)) {
      penalty += 0.08;
    }
  }
  return Math.min(penalty, 0.4);
}

export async function scoreLinksForQuery({ query, links, baseUrl = '' } = {}) {
  const items = Array.isArray(links) ? links.filter((link) => link?.url) : [];
  if (!items.length) return [];

  const queryText = normalizeWhitespace(query);
  const queryTokens = tokenize(queryText);
  const baseDomain = extractDomain(baseUrl);
  const semanticInputs = items.map((link) =>
    normalizeWhitespace(`${link.text || ''} ${link.url || ''}`).slice(0, 360)
  );

  let semanticScores = new Array(items.length).fill(0);
  if (queryText) {
    try {
      const embeddingClient = await import('./embedding-client.js').catch(() => null);
      const getEmbedding = embeddingClient?.getEmbedding;
      const getEmbeddings = embeddingClient?.getEmbeddings;
      const cosineSimilarity = embeddingClient?.cosineSimilarity;
      if (!getEmbedding || !getEmbeddings || !cosineSimilarity) {
        throw new Error('Embedding client unavailable');
      }

      const queryEmbedding = await getEmbedding(queryText);
      if (queryEmbedding) {
        const linkEmbeddings = await getEmbeddings(semanticInputs);
        semanticScores = linkEmbeddings.map((embedding) =>
          embedding ? Math.max(0, cosineSimilarity(queryEmbedding, embedding)) : 0
        );
      }
    } catch {
      semanticScores = new Array(items.length).fill(0);
    }
  }

  const scored = items.map((link, index) => {
    const normalizedUrl = String(link.url || '').trim();
    const text = normalizeWhitespace(link.text || '');
    const domain = extractDomain(normalizedUrl);
    const lexical = keywordScore(`${text} ${normalizedUrl}`, queryTokens);
    const semantic = semanticScores[index] || 0;
    const sameSite = baseDomain && domain && baseDomain === domain ? 0.14 : 0;
    const pathBoost = pathHintBoost(normalizedUrl, queryTokens);
    const penalty = noisePenalty(normalizedUrl);

    const relevanceScore = (lexical * 0.55) + (semantic * 0.35) + sameSite + pathBoost - penalty;
    return {
      ...link,
      domain: link.domain || domain,
      sameSite: typeof link.sameSite === 'boolean' ? link.sameSite : sameSite > 0,
      relevance_score: Number(relevanceScore.toFixed(4)),
      relevance: {
        lexical: Number(lexical.toFixed(4)),
        semantic: Number(semantic.toFixed(4)),
        same_site: Number(sameSite.toFixed(4)),
        path_boost: Number(pathBoost.toFixed(4)),
        penalty: Number(penalty.toFixed(4))
      }
    };
  });

  scored.sort((left, right) => right.relevance_score - left.relevance_score);
  return scored;
}

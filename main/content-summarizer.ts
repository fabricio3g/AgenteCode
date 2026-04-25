function normalizeWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function tokenize(text) {
  return normalizeWhitespace(text).toLowerCase().match(/[a-z0-9]+/g) || [];
}

function keywordDensityScore(text, queryTerms) {
  if (!queryTerms.length) return 0;
  const haystack = normalizeWhitespace(text).toLowerCase();
  if (!haystack) return 0;
  let score = 0;
  for (const term of queryTerms) {
    if (!term) continue;
    if (haystack.includes(term)) {
      const matches = haystack.match(new RegExp(`\\b${term}\\b`, 'g')) || [];
      score += 1 + Math.min(matches.length, 4) * 0.2;
    }
  }
  return score;
}

function topParagraphsByQuery(text, queryTerms, maxChars) {
  const paragraphs = String(text || '')
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph, index) => ({
      paragraph,
      index,
      score: keywordDensityScore(paragraph, queryTerms)
    }));

  if (!paragraphs.length) return '';

  const ranked = [...paragraphs].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.index - right.index;
  });

  const selected = [];
  let used = 0;
  for (const item of ranked) {
    if (used >= maxChars) break;
    const candidate = item.paragraph;
    if (!candidate) continue;
    selected.push(item);
    used += candidate.length + 2;
  }

  selected.sort((left, right) => left.index - right.index);
  return selected.map((item) => item.paragraph).join('\n\n').slice(0, maxChars);
}

export function summarizeCrawledPages({ pages, query, targetChars } = {}) {
  const list = Array.isArray(pages) ? pages : [];
  const budget = Math.max(500, Number(targetChars) || 4000);
  if (!list.length) return { text: '', truncated: false, usedChars: 0 };

  const queryTerms = tokenize(query).slice(0, 12);
  const rankedPages = [...list].sort((left, right) => {
    const leftDepth = Number(left?.depth || 0);
    const rightDepth = Number(right?.depth || 0);
    if (leftDepth !== rightDepth) return leftDepth - rightDepth;
    return Number(right?.score || 0) - Number(left?.score || 0);
  });

  const blocks = [];
  let used = 0;
  for (const page of rankedPages) {
    if (used >= budget) break;
    const pageBudget = Math.max(600, Math.min(2200, Math.floor((budget - used) * 0.55)));
    const condensed = topParagraphsByQuery(page?.content || '', queryTerms, pageBudget);
    if (!condensed) continue;
    const block = [
      `## ${page?.title || page?.url || 'Untitled page'}`,
      page?.url ? `URL: ${page.url}` : null,
      condensed
    ].filter(Boolean).join('\n\n');
    if (!block) continue;
    blocks.push(block);
    used += block.length + 6;
  }

  let text = blocks.join('\n\n---\n\n');
  let truncated = false;

  if (text.length > budget) {
    text = text.slice(0, budget).trim();
    truncated = true;
  }

  if (blocks.length < list.length) {
    truncated = true;
  }

  return {
    text,
    truncated,
    usedChars: text.length
  };
}

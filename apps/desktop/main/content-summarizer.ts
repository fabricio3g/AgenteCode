import { normalizeWhitespace, tokenize } from './search-providers/shared.ts';

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

  // Take the best paragraphs that fit whole (the best one is cut to fit if
  // it alone is too long). Picking past the budget and cutting the joined
  // text afterwards dropped exactly the late, relevant paragraph once the
  // selection went back into page order.
  const selected = [];
  let used = 0;
  for (const item of ranked) {
    const room = maxChars - used;
    if (room <= 0) break;
    const candidate = item.paragraph;
    if (!candidate) continue;
    if (candidate.length > room) {
      if (!selected.length) {
        selected.push({ ...item, paragraph: candidate.slice(0, room) });
        used = maxChars;
      }
      continue;
    }
    selected.push(item);
    used += candidate.length + 2;
  }

  selected.sort((left, right) => left.index - right.index);
  return selected.map((item) => item.paragraph).join('\n\n').slice(0, maxChars);
}

export function summarizeCrawledPages({ pages, query, targetChars } = {}) {
  const list = Array.isArray(pages) ? pages : [];
  const budget = Math.max(500, Number(targetChars) || 4000);
  if (!list.length) return { text: '', truncated: false, omitted: 0, usedChars: 0 };

  const queryTerms = tokenize(query).slice(0, 12);
  const rankedPages = [...list].sort((left, right) => {
    const leftDepth = Number(left?.depth || 0);
    const rightDepth = Number(right?.depth || 0);
    if (leftDepth !== rightDepth) return leftDepth - rightDepth;
    return Number(right?.score || 0) - Number(left?.score || 0);
  });

  // Each page gets a fair share of what is left, so every source keeps a
  // short excerpt instead of the first pages taking the whole budget.
  const blocks = [];
  const omittedUrls = [];
  let used = 0;
  for (let i = 0; i < rankedPages.length; i += 1) {
    const page = rankedPages[i];
    const header = [
      `## ${page?.title || page?.url || 'Untitled page'}`,
      page?.url ? `URL: ${page.url}` : null
    ].filter(Boolean).join('\n\n');
    const share = Math.floor((budget - used) / (rankedPages.length - i)) - header.length - 12;
    const pageBudget = Math.min(2200, share);
    const condensed = pageBudget >= 120 ? topParagraphsByQuery(page?.content || '', queryTerms, pageBudget) : '';
    if (!condensed) {
      if (page?.url) omittedUrls.push(page.url);
      continue;
    }
    const block = `${header}\n\n${condensed}`;
    blocks.push(block);
    used += block.length + 7;
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
  if (omittedUrls.length) {
    text = `${text}\n\n(Not included for space: ${omittedUrls.join(', ')})`;
  }

  return {
    text,
    truncated,
    omitted: list.length - blocks.length,
    usedChars: text.length
  };
}

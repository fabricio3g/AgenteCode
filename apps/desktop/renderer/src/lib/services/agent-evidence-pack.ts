import type { SearchResult } from '$lib/types/bridge';
import type { RequestMessage } from '$lib/services/chat-api';
import type { ToolObservation } from '$lib/services/agent-types';

function clean(value: unknown, max = 900): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function domainLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function queryTerms(query: string): string[] {
  return clean(query, 200)
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((t) => t.length > 2)
    .slice(0, 14) || [];
}

function scoreText(text: string, terms: string[]): number {
  const hay = text.toLowerCase();
  if (!hay || !terms.length) return 0;
  let score = 0;
  for (const term of terms) {
    if (hay.includes(term)) score += 1;
    const hits = hay.match(new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')) || [];
    score += Math.min(hits.length, 4) * 0.2;
  }
  return score;
}

/** Pull the most query-relevant paragraphs from long page text. */
export function extractRelevantExcerpt(content: string, query: string, maxChars = 1200): string {
  const normalized = String(content || '').trim();
  if (!normalized) return '';

  const terms = queryTerms(query);
  const blocks = normalized.split(/\n\s*\n+/).map((b) => b.trim()).filter((b) => b.length > 40);

  // Single short block or no multi-paragraph structure — return as-is (possibly truncated).
  if (!terms.length || blocks.length <= 1) {
    return clean(normalized, maxChars);
  }

  const ranked = blocks
    .map((paragraph, index) => ({ paragraph, index, score: scoreText(paragraph, terms) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  // Prefer paragraphs that actually match the query when any matches exist.
  const relevant = ranked.filter((item) => item.score > 0);
  const pool = relevant.length ? relevant : ranked;

  // If nothing is especially relevant and the whole page fits, keep full text.
  if (!relevant.length && normalized.length <= maxChars) {
    return normalized;
  }

  const selected: typeof ranked = [];
  let used = 0;
  for (const item of pool) {
    if (used >= maxChars) break;
    if (used + item.paragraph.length > maxChars * 1.1 && selected.length) continue;
    selected.push(item);
    used += item.paragraph.length + 2;
  }
  selected.sort((a, b) => a.index - b.index);
  return selected.map((s) => s.paragraph).join('\n\n').slice(0, maxChars);
}

export type ResearchPackOptions = {
  query?: string;
  mode?: 'search' | 'deep' | 'max';
  maxSources?: number;
  maxExcerptChars?: number;
  maxTotalChars?: number;
  maxFacts?: number;
};

/**
 * Compact, model-oriented evidence pack for deep/max research synthesis.
 * Prefer full_content excerpts over short snippets.
 */
export function buildResearchEvidencePack(
  observations: ToolObservation[],
  sources: SearchResult[],
  options: ResearchPackOptions = {}
): string {
  const mode = options.mode || 'deep';
  const query = clean(options.query, 240);
  // Research packs are not token-budgeted: high defaults so synthesis can use full evidence.
  // Callers may still pass explicit caps; leave unset for full research depth.
  const maxSources = options.maxSources ?? (mode === 'max' ? 40 : mode === 'deep' ? 28 : 16);
  const maxExcerpt = options.maxExcerptChars ?? (mode === 'max' ? 4000 : mode === 'deep' ? 3000 : 1800);
  const maxTotal = options.maxTotalChars ?? (mode === 'max' ? 120_000 : mode === 'deep' ? 80_000 : 40_000);
  const maxFacts = options.maxFacts ?? (mode === 'max' ? 60 : mode === 'deep' ? 40 : 24);
  const terms = queryTerms(query);

  // Prefer sources with longer readable content; skip obvious blocked empty
  const rankedSources = [...(Array.isArray(sources) ? sources : [])]
    .filter((s) => s?.url)
    .map((s) => {
      const body = String(s.full_content || s.snippet || '');
      const quality = String(s.metadata?.quality || '');
      const blocked = quality === 'blocked' || body.length < 40;
      const score =
        (blocked ? -10 : 0)
        + Math.min(body.length / 400, 8)
        + scoreText(`${s.title || ''} ${s.snippet || ''}`, terms) * 2
        + scoreText(body.slice(0, 2000), terms);
      return { s, body, blocked, score };
    })
    .sort((a, b) => b.score - a.score);

  const lines: string[] = [
    '=== RESEARCH EVIDENCE PACK ===',
    `Query: ${query || '(unknown)'}`,
    `Mode: ${mode}`,
    `Sources (${Math.min(rankedSources.length, maxSources)}):`
  ];

  const usedSources = rankedSources.slice(0, maxSources);
  let total = lines.join('\n').length;

  for (let i = 0; i < usedSources.length; i += 1) {
    const { s, body, blocked } = usedSources[i];
    const id = i + 1;
    const title = clean(s.title || s.url, 160);
    const domain = domainLabel(s.url || '');
    const quality = blocked
      ? 'thin/blocked'
      : (s.full_content ? 'full' : 'snippet');
    const author = clean(s.metadata?.author || '', 120);
    const published = clean(s.published_at || s.metadata?.published_at || '', 40);
    const site = clean(s.metadata?.site_name || domain || 'web', 80);
    const excerpt = extractRelevantExcerpt(body || s.snippet || '', query, maxExcerpt);
    const bib = [
      author ? `Author: ${author}` : '',
      published ? `Date: ${published}` : 'Date: (n.d.)',
      site ? `Site: ${site}` : ''
    ].filter(Boolean).join(' | ');
    const block = [
      `[${id}] ${title} | ${domain || 'web'} | ${quality}`,
      s.url ? `    URL: ${s.url}` : '',
      bib ? `    APA fields: ${bib}` : '',
      excerpt ? `    Excerpt: ${excerpt}` : '    Excerpt: (empty)'
    ].filter(Boolean).join('\n');
    if (total + block.length > maxTotal) break;
    lines.push(block);
    total += block.length + 1;
  }

  // Facts from successful observations + top source sentences
  const facts: string[] = [];
  const seen = new Set<string>();
  const addFact = (text: string, sourceId?: number) => {
    const t = clean(text, 320);
    if (t.length < 40) return;
    if (/^(search query|searched_at|mode|urls_to_consider|next_step):/i.test(t)) return;
    const key = t.toLowerCase().slice(0, 120);
    if (seen.has(key)) return;
    seen.add(key);
    facts.push(sourceId ? `- ${t} [${sourceId}]` : `- ${t}`);
  };

  for (const obs of observations.filter((o) => o.success && o.summary).slice(0, 12)) {
    for (const line of String(obs.summary).split(/\n+/)) {
      const cleaned = line.replace(/^\d+\.\s*/, '').replace(/^[-*]\s*/, '').trim();
      if (cleaned.length > 50 && !cleaned.startsWith('http') && !cleaned.startsWith('Search query')) {
        addFact(cleaned);
      }
      if (facts.length >= maxFacts) break;
    }
    if (facts.length >= maxFacts) break;
  }

  for (let i = 0; i < usedSources.length && facts.length < maxFacts; i += 1) {
    const excerpt = extractRelevantExcerpt(
      String(usedSources[i].body || usedSources[i].s.snippet || ''),
      query,
      600
    );
    const firstSentence = excerpt.split(/(?<=[.!?])\s+/)[0];
    if (firstSentence) addFact(firstSentence, i + 1);
  }

  if (facts.length) {
    lines.push('', `Facts (use these; cite [n] where applicable):`, ...facts.slice(0, maxFacts));
  }

  lines.push(
    '',
    'Instructions: Write the final polished APA 7 research report the user will read. Do NOT paste this pack. Do NOT title sections "Gathered Evidence" or "Summary". Cite as [1], [2] and APA author–date when APA fields exist. Use (n.d.) when date is missing. Never invent authors/dates. Never mention tools, step limits, or agent status.',
    '=== END EVIDENCE PACK ==='
  );

  let out = lines.join('\n');
  if (out.length > maxTotal) out = out.slice(0, maxTotal) + '\n… (pack truncated)';
  return out;
}

export function injectResearchEvidencePack(
  messages: RequestMessage[],
  observations: ToolObservation[],
  sources: SearchResult[],
  options: ResearchPackOptions = {}
): void {
  const idx = messages.findIndex(
    (m) => m.role === 'system' && typeof m.content === 'string' && (
      m.content.startsWith('=== RESEARCH EVIDENCE PACK ===')
      || m.content.startsWith('=== EVIDENCE SUMMARY ===')
    )
  );
  if (idx >= 0) messages.splice(idx, 1);

  if (!observations.some((o) => o.success) && !sources.length) return;

  const pack = buildResearchEvidencePack(observations, sources, options);
  messages.push({ role: 'system', content: pack });
}

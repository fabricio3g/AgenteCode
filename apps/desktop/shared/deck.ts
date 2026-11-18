// ── Slide decks (main ⇄ renderer) ──────────────────────────────────────
// What `create_presentation` describes and what main/slides.ts draws. The
// normalizer turns loose model output into a deck with a layout per slide,
// so a slide with a table becomes a table slide, a slide with numbers a
// stats slide, and so on, even when the model didn't name the layout.

import { resolveAccent, resolveTheme, type ArtifactAccent, type ArtifactTheme } from './artifact-theme.ts';
import { text, tableData, type SheetInput } from './work-product.ts';
import { Lexer, type Token } from 'marked';

/** PowerPoint text boxes use plain text; keep evidence URLs while removing markup. */
function prose(value: unknown): string {
  const plain = (tokens: Token[]): string => tokens.map((token) => {
    if (token.type === 'br') return '\n';
    if (token.type === 'link') {
      const link = token as { tokens: Token[]; href: string };
      const label = plain(link.tokens); return label === link.href ? label : `${label} (${link.href})`;
    }
    if ('tokens' in token && Array.isArray(token.tokens)) return plain(token.tokens);
    return 'text' in token ? String(token.text) : token.raw;
  }).join('');
  return plain(Lexer.lexInline(text(value)));
}

const DECK_LAYOUTS = ['title', 'section', 'bullets', 'two-column', 'quote', 'stats', 'table', 'chart'] as const;
export type DeckLayout = (typeof DECK_LAYOUTS)[number];
export type DeckChartType = 'bar' | 'column' | 'line' | 'pie' | 'doughnut';

export interface DeckColumn {
  heading?: string;
  bullets: string[];
}

export interface DeckSlide {
  layout: DeckLayout;
  title: string;
  subtitle?: string;
  bullets: string[];
  /** The same bullets; kept for the older slide viewer and deck readers. */
  content: string[];
  left?: DeckColumn;
  right?: DeckColumn;
  quote?: string;
  attribution?: string;
  stats?: Array<{ value: string; label: string }>;
  table?: { columns: string[]; rows: string[][] };
  chart?: { type: DeckChartType; labels: string[]; series: Array<{ name: string; values: number[] }> };
  notes?: string | null;
}

export interface DeckSpec {
  title: string;
  subtitle?: string;
  theme: ArtifactTheme;
  accent: ArtifactAccent;
  slides: DeckSlide[];
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => prose(item).replace(/^[-*•]\s*/, '')).filter(Boolean);
  const single = text(value);
  if (!single) return [];
  return single.split(/\n+/).map((line) => prose(line).replace(/^[-*•]\s*/, '').trim()).filter(Boolean);
}

function column(value: unknown): DeckColumn | undefined {
  if (!value) return undefined;
  if (Array.isArray(value) || typeof value === 'string') return { bullets: list(value) };
  const item = value as Record<string, unknown>;
  const bullets = list(item.bullets ?? item.content ?? item.points);
  const heading = text(item.heading ?? item.title);
  return bullets.length || heading ? { ...(heading ? { heading } : {}), bullets } : undefined;
}

function table(value: unknown): DeckSlide['table'] {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  const { headers, rows } = tableData(item as SheetInput);
  return headers.length && rows.length ? { columns: headers, rows } : undefined;
}

function chart(value: unknown): DeckSlide['chart'] {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  const labels = list(item.labels ?? item.categories);
  const rawSeries = Array.isArray(item.series) ? item.series : Array.isArray(item.datasets) ? item.datasets : [];
  const series = rawSeries.map((entry, index) => {
    const s = (entry ?? {}) as Record<string, unknown>;
    const values = (Array.isArray(s.values) ? s.values : Array.isArray(s.data) ? s.data : []).map(Number);
    if (values.length !== labels.length || values.some((value) => !Number.isFinite(value))) throw new Error('Every chart series must contain one finite number per label.');
    return { name: text(s.name ?? s.label, `Series ${index + 1}`), values };
  }).filter((s) => s.values.length);
  if (!labels.length || !series.length) return undefined;
  const type = text(item.type ?? item.chart_type, 'column').toLowerCase();
  if (['pie', 'donut', 'doughnut'].includes(type) && series.some((entry) => entry.values.some((value) => value < 0))) throw new Error('Pie charts require non-negative values.');
  const known: Record<string, DeckChartType> = { bar: 'bar', column: 'column', line: 'line', pie: 'pie', donut: 'doughnut', doughnut: 'doughnut' };
  return { type: known[type] ?? 'column', labels, series };
}

function stats(value: unknown): DeckSlide['stats'] {
  if (!Array.isArray(value)) return undefined;
  const out = value.map((entry) => {
    const s = (entry ?? {}) as Record<string, unknown>;
    return { value: text(s.value ?? s.number), label: text(s.label ?? s.caption) };
  }).filter((s) => s.value);
  return out.length ? out : undefined;
}

function inferLayout(slide: Omit<DeckSlide, 'layout'>, index: number, total: number): DeckLayout {
  if (slide.chart) return 'chart';
  if (slide.table) return 'table';
  if (slide.stats) return 'stats';
  if (slide.quote) return 'quote';
  if (slide.left || slide.right) return 'two-column';
  // A lone slide is content, not a cover.
  if (index === 0 && total > 1 && slide.bullets.length <= 1) return 'title';
  if (!slide.bullets.length) return 'section';
  return 'bullets';
}

/** Loose `create_presentation` arguments → a deck every builder can draw. */
export function normalizeDeck(input: Record<string, unknown>): DeckSpec {
  const title = text(input.title, 'Presentation');
  const raw = Array.isArray(input.slides) ? input.slides as Array<Record<string, unknown>> : [];
  const slides = raw.map((entry, index): DeckSlide => {
    const item = entry ?? {};
    const bullets = list(item.bullets ?? item.content ?? item.points);
    const base = {
      title: text(item.title ?? item.heading, index === 0 ? title : ''),
      subtitle: text(item.subtitle) || undefined,
      bullets,
      content: bullets,
      left: column(item.left),
      right: column(item.right),
      quote: text(item.quote) || undefined,
      attribution: text(item.attribution ?? item.author) || undefined,
      stats: stats(item.stats ?? item.metrics),
      table: table(item.table),
      chart: chart(item.chart),
      notes: text(item.notes) || null
    };
    const requested = text(item.layout).toLowerCase().replace(/[\s_]+/g, '-') as DeckLayout;
    const layout = (DECK_LAYOUTS as readonly string[]).includes(requested) ? requested : inferLayout(base, index, raw.length);
    // The title slide's single line is its subtitle, not a bullet.
    if (layout === 'title' && !base.subtitle && bullets.length === 1) {
      return { ...base, layout, subtitle: bullets[0], bullets: [], content: [] };
    }
    return { ...base, layout };
  }).filter((slide) => slide.title || slide.bullets.length || slide.table || slide.chart || slide.stats || slide.quote || slide.left || slide.right);
  return {
    title,
    ...(text(input.subtitle) ? { subtitle: text(input.subtitle) } : {}),
    theme: resolveTheme(input.theme),
    accent: resolveAccent(input.accent ?? 'blue'),
    slides: slides.flatMap((slide) => {
      if (slide.stats && slide.stats.length > 4) {
        const pages = Math.ceil(slide.stats.length / 4);
        return Array.from({ length: pages }, (_, index) => ({ ...slide, title: `${slide.title} (${index + 1}/${pages})`, stats: slide.stats!.slice(index * 4, index * 4 + 4) }));
      }
      const rows = slide.table?.rows;
      if (!rows || rows.length <= 10) return [slide];
      const pages = Math.ceil(rows.length / 10);
      return Array.from({ length: pages }, (_, index) => ({ ...slide,
        title: `${slide.title} (${index + 1}/${pages})`,
        table: { columns: slide.table!.columns, rows: rows.slice(index * 10, (index + 1) * 10) },
      }));
    })
  };
}

/** Text people can find, including data and notes, without implementation keys. */
export function deckSlideText(slide: DeckSlide): string {
  return [slide.title, slide.subtitle, ...slide.bullets, slide.quote, slide.attribution,
    slide.left?.heading, ...(slide.left?.bullets || []), slide.right?.heading, ...(slide.right?.bullets || []),
    ...(slide.stats || []).flatMap((item) => [item.label, item.value]),
    ...(slide.table?.columns || []), ...(slide.table?.rows.flat() || []),
    ...(slide.chart?.labels || []), ...(slide.chart?.series.flatMap((item) => [item.name, ...item.values]) || []), slide.notes,
  ].filter((value) => value !== undefined && value !== null).join('\n');
}

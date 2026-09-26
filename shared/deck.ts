// ── Slide decks (main ⇄ renderer) ──────────────────────────────────────
// What `create_presentation` describes and what main/slides.ts draws. The
// normalizer turns loose model output into a deck with a layout per slide,
// so a slide with a table becomes a table slide, a slide with numbers a
// stats slide, and so on, even when the model didn't name the layout.

import { resolveAccent, resolveTheme, type ArtifactAccent, type ArtifactTheme } from './artifact-theme.ts';
import { text } from './work-product.ts';

export const DECK_LAYOUTS = ['title', 'section', 'bullets', 'two-column', 'quote', 'stats', 'table', 'chart'] as const;
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
  if (Array.isArray(value)) return value.map((item) => text(item).replace(/^[-*•]\s*/, '')).filter(Boolean);
  const single = text(value);
  if (!single) return [];
  return single.split(/\n+/).map((line) => line.replace(/^[-*•]\s*/, '').trim()).filter(Boolean);
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
  const rows = Array.isArray(item.rows) ? item.rows : [];
  let columns = Array.isArray(item.columns) ? item.columns.map((col) => text(typeof col === 'object' && col ? (col as { header?: string; name?: string }).header ?? (col as { name?: string }).name : col)) : [];
  if (!columns.length && rows[0] && typeof rows[0] === 'object' && !Array.isArray(rows[0])) columns = Object.keys(rows[0] as object);
  const cells = rows.map((row) => Array.isArray(row)
    ? row.map((cell) => text(cell))
    : columns.map((key) => text((row as Record<string, unknown>)?.[key])));
  return columns.length && cells.length ? { columns, rows: cells.slice(0, 12) } : undefined;
}

function chart(value: unknown): DeckSlide['chart'] {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  const labels = list(item.labels ?? item.categories);
  const rawSeries = Array.isArray(item.series) ? item.series : Array.isArray(item.datasets) ? item.datasets : [];
  const series = rawSeries.map((entry, index) => {
    const s = (entry ?? {}) as Record<string, unknown>;
    const values = (Array.isArray(s.values) ? s.values : Array.isArray(s.data) ? s.data : []).map(Number).filter(Number.isFinite);
    return { name: text(s.name ?? s.label, `Series ${index + 1}`), values };
  }).filter((s) => s.values.length);
  if (!labels.length || !series.length) return undefined;
  const type = text(item.type ?? item.chart_type, 'column').toLowerCase();
  const known: Record<string, DeckChartType> = { bar: 'bar', column: 'column', line: 'line', pie: 'pie', donut: 'doughnut', doughnut: 'doughnut' };
  return { type: known[type] ?? 'column', labels, series };
}

function stats(value: unknown): DeckSlide['stats'] {
  if (!Array.isArray(value)) return undefined;
  const out = value.map((entry) => {
    const s = (entry ?? {}) as Record<string, unknown>;
    return { value: text(s.value ?? s.number), label: text(s.label ?? s.caption) };
  }).filter((s) => s.value).slice(0, 4);
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
    slides
  };
}

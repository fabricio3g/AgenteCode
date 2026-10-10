/**
 * Turns what the reference page script counted into design tokens: colours
 * clustered by eye (near-identical shades merge), type and spacing scales
 * deduped, and the three things a reference leaves behind: tokens.css,
 * DESIGN.md and the short brief the model reads. Pure on purpose: no DOM and
 * no Electron, so every rule here has a node test.
 */
import { REFERENCE_WIDTH } from '../../shared/design.ts';

export type ColorRole = 'text' | 'background' | 'border' | 'button';

/** What the page script measured. Every list is already tallied in the page; this module only ranks and merges. */
export interface ReferenceCapture {
  url: string;
  title: string;
  width: number;
  height: number;
  scrollHeight: number;
  /** Elements the page script looked at (it stops at a fixed cap). */
  sampled: number;
  /** Colours as `#rrggbb`, or `rgba(r, g, b, a)` when translucent. */
  colors: Array<{ role: ColorRole; color: string; count: number }>;
  fonts: Array<{ role: 'text' | 'heading'; family: string; count: number }>;
  /** One entry per distinct (role, size, weight, line height, family); `lineHeight` is px, 0 for `normal`. */
  types: Array<{ role: string; size: number; weight: number; lineHeight: number; family: string; count: number }>;
  spacing: Array<{ value: number; count: number }>;
  radii: Array<{ value: string; count: number }>;
  shadows: Array<{ value: string; count: number }>;
  maxWidths: Array<{ value: number; count: number }>;
  gridColumns: Array<{ value: number; count: number }>;
  sections: number;
  hasNav: boolean;
  hasFooter: boolean;
}

export interface Counted<T> { value: T; count: number }
export interface TypeStyle { size: number; weight: number; lineHeight: number; family: string }

export interface ReferenceTokens {
  url: string;
  title: string;
  width: number;
  sampled: number;
  palette: {
    text: string;
    background: string;
    surface: string;
    muted: string;
    accent: string | null;
    border: string | null;
  };
  /** Ranked shades behind each role, for the brief. */
  shades: { text: Counted<string>[]; background: Counted<string>[]; border: Counted<string>[] };
  fonts: { body: string; heading: string; families: Counted<string>[] };
  /** Keyed by role: h1–h6, body, small, button. */
  type: Record<string, TypeStyle>;
  spacing: number[];
  radii: string[];
  shadows: string[];
  contentWidth: number | null;
  gridColumns: number[];
  sections: number;
  hasNav: boolean;
  hasFooter: boolean;
}

interface Rgba { r: number; g: number; b: number; a: number }

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const channel = (text: string) => (text.endsWith('%') ? (parseFloat(text) * 255) / 100 : parseFloat(text));

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` and `rgb()`/`rgba()` in comma or space syntax, or null. */
export function parseColor(value: string): Rgba | null {
  const text = String(value || '').trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(text);
  if (hex) {
    let digits = hex[1];
    if (digits.length === 3 || digits.length === 4) digits = digits.split('').map((ch) => ch + ch).join('');
    if (digits.length !== 6 && digits.length !== 8) return null;
    const rgb = [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16));
    const a = digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1;
    return { r: rgb[0], g: rgb[1], b: rgb[2], a };
  }
  const fn = /^rgba?\((.*)\)$/.exec(text);
  if (!fn) return null;
  const parts = fn[1].replace('/', ' ').split(/[\s,]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const [r, g, b] = parts.slice(0, 3).map(channel);
  const a = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
  if ([r, g, b, a].some((n) => Number.isNaN(n))) return null;
  return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255), a: clamp(a, 0, 1) };
}

export function toHex(color: Rgba): string {
  return `#${[color.r, color.g, color.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

/** Greys and near-greys: the channels barely differ. */
export function isNeutral(color: Rgba): boolean {
  return Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b) < 24;
}

const distance = (a: Rgba, b: Rgba) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);

/**
 * Rank colours by how often they appear and merge the shades that look the
 * same (within `threshold` on the RGB cube), keeping the most frequent shade
 * of each group. Translucent colours below half opacity are not colours.
 */
export function clusterColors(entries: Array<{ color: string; count: number }>, options: { limit?: number; threshold?: number } = {}): Counted<string>[] {
  const { limit = 6, threshold = 24 } = options;
  const parsed = entries
    .map((entry) => ({ rgb: parseColor(entry.color), count: entry.count }))
    .filter((entry): entry is { rgb: Rgba; count: number } => !!entry.rgb && entry.rgb.a >= 0.5 && entry.count > 0)
    .sort((a, b) => b.count - a.count);
  const clusters: Array<{ rgb: Rgba; count: number }> = [];
  for (const item of parsed) {
    const hit = clusters.find((cluster) => distance(cluster.rgb, item.rgb) <= threshold);
    if (hit) hit.count += item.count;
    else clusters.push({ rgb: item.rgb, count: item.count });
  }
  return clusters
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((cluster) => ({ value: toHex(cluster.rgb), count: cluster.count }));
}

/** The accent: the most used saturated colour on buttons, else the most used saturated colour anywhere but borders. */
export function pickAccent(colors: ReferenceCapture['colors']): string | null {
  const saturated = (role: ColorRole | ColorRole[]) => {
    const roles = Array.isArray(role) ? role : [role];
    const ranked = clusterColors(colors.filter((entry) => roles.includes(entry.role)), { limit: 12 });
    return ranked.find((entry) => {
      const rgb = parseColor(entry.value);
      return !!rgb && !isNeutral(rgb);
    })?.value ?? null;
  };
  return saturated('button') ?? saturated(['text', 'background']);
}

/** The most common value, ties going to the larger one. */
function modeOf<T>(items: Array<{ value: T; count: number }>, key: (value: T) => number = () => 0): T | null {
  let best: { value: T; count: number } | null = null;
  for (const item of items) {
    if (!best || item.count > best.count || (item.count === best.count && key(item.value) > key(best.value))) best = item;
  }
  return best?.value ?? null;
}

/** Families merged by name, ranked by how many elements use them. */
export function fontFamilies(fonts: ReferenceCapture['fonts']): Counted<string>[] {
  const totals = new Map<string, number>();
  for (const font of fonts) {
    const family = cleanFamily(font.family);
    if (family) totals.set(family, (totals.get(family) ?? 0) + font.count);
  }
  return [...totals.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
}

const cleanFamily = (raw: string) => raw.split(',')[0].replace(/["']/g, '').replace(/[;{}<>\\]/g, '').trim();

/**
 * One style per role: the most common (size, weight, line height, family) the
 * page uses for that element. A role the page never shows is left out.
 */
export function typeScale(types: ReferenceCapture['types']): Record<string, TypeStyle> {
  const out: Record<string, TypeStyle> = {};
  const roles = [...new Set(types.map((type) => type.role))];
  for (const role of roles) {
    const rows = types.filter((type) => type.role === role).map((type) => ({ value: type, count: type.count }));
    const best = modeOf(rows, (type) => type.size);
    if (best) out[role] = { size: best.size, weight: best.weight, lineHeight: best.lineHeight, family: cleanFamily(best.family) };
  }
  return out;
}

/** Spacing values that the page actually uses: the most common first, shades of one value merged, then ascending. */
export function spacingScale(entries: ReferenceCapture['spacing'], limit = 10): number[] {
  const ranked = entries
    .filter((entry) => entry.value >= 1 && entry.value <= 200 && Number.isFinite(entry.value))
    .sort((a, b) => b.count - a.count || a.value - b.value);
  const kept: number[] = [];
  for (const entry of ranked) {
    if (!kept.some((value) => Math.abs(value - entry.value) <= 1)) kept.push(entry.value);
    if (kept.length >= limit) break;
  }
  return kept.sort((a, b) => a - b);
}

/** A few distinct values of a list, most common first, with the zero/empty ones dropped. */
function topValues(entries: Array<{ value: string; count: number }>, limit: number, skip: (value: string) => boolean = () => false): string[] {
  const seen = new Map<string, number>();
  for (const entry of entries) {
    const value = entry.value.replace(/\s+/g, ' ').trim();
    if (!value || skip(value)) continue;
    seen.set(value, (seen.get(value) ?? 0) + entry.count);
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([value]) => value);
}

/**
 * The next shade after `chosen`: a neutral one when the page has one (a surface
 * tint, a muted grey), else any other shade. Accents such as a button's fill
 * never stand in for a surface or a muted text colour.
 */
export function secondShade(shades: Counted<string>[], chosen: string): string {
  const others = shades.filter((entry) => entry.value !== chosen);
  const neutral = others.find((entry) => {
    const rgb = parseColor(entry.value);
    return !!rgb && isNeutral(rgb);
  });
  return neutral?.value ?? others[0]?.value ?? chosen;
}

export function buildReferenceTokens(capture: ReferenceCapture): ReferenceTokens {
  const shades = {
    text: clusterColors(capture.colors.filter((entry) => entry.role === 'text')),
    background: clusterColors(capture.colors.filter((entry) => entry.role === 'background')),
    border: clusterColors(capture.colors.filter((entry) => entry.role === 'border'))
  };
  const text = shades.text[0]?.value ?? '#111111';
  const background = shades.background[0]?.value ?? '#ffffff';
  const families = fontFamilies(capture.fonts);
  const headingFamilies = fontFamilies(capture.fonts.filter((font) => font.role === 'heading'));
  const body = fontFamilies(capture.fonts.filter((font) => font.role === 'text'))[0]?.value ?? families[0]?.value ?? 'sans-serif';
  const contentWidth = modeOf(capture.maxWidths.map((entry) => ({ value: entry.value, count: entry.count })), (value) => value);
  return {
    url: capture.url,
    title: capture.title,
    width: capture.width,
    sampled: capture.sampled,
    palette: {
      text,
      background,
      surface: secondShade(shades.background, background),
      muted: secondShade(shades.text, text),
      accent: pickAccent(capture.colors),
      border: shades.border[0]?.value ?? null
    },
    shades,
    fonts: { body, heading: headingFamilies[0]?.value ?? body, families: families.slice(0, 4) },
    type: typeScale(capture.types),
    spacing: spacingScale(capture.spacing),
    // The four most used radii, smallest first, so `--radius-sm` is the tightest corner.
    radii: topValues(capture.radii.map((entry) => ({ value: entry.value, count: entry.count })), 4, (value) => /^0(px)?$/.test(value))
      .sort((a, b) => parseFloat(a) - parseFloat(b)),
    shadows: topValues(capture.shadows.map((entry) => ({ value: entry.value, count: entry.count })), 3),
    contentWidth: contentWidth === null ? null : Math.round(contentWidth),
    gridColumns: [...capture.gridColumns].sort((a, b) => b.count - a.count).slice(0, 3).map((entry) => entry.value),
    sections: capture.sections,
    hasNav: capture.hasNav,
    hasFooter: capture.hasFooter
  };
}

/** A CSS value from the page, with anything that could end a declaration removed. */
const safe = (value: string) => value.replace(/[;{}<>\r\n]/g, '').trim();
/** Text placed inside a CSS comment: also cannot close it early. */
const comment = (value: string) => safe(value).replace(/\*\//g, '');
const px = (value: number) => `${Math.round(value)}px`;

const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace']);
/** A font stack: the page's family, then a generic that matches its look. */
export function fontStack(family: string): string {
  const name = safe(family);
  if (!name) return 'system-ui, sans-serif';
  if (GENERIC.has(name.toLowerCase())) return name;
  const generic = /mono|code|courier/i.test(name) ? 'monospace' : /serif/i.test(name) && !/sans/i.test(name) ? 'serif' : /playfair|garamond|georgia|times|didot|bodoni|merriweather|lora/i.test(name) ? 'serif' : 'sans-serif';
  return `"${name}", ${generic}`;
}

const TYPE_TOKEN: Record<string, string> = { p: 'body', small: 'small', button: 'button', h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h5', h6: 'h6' };

/** tokens.css: the semantic colour roles the design prompt names, plus the type, space, radius, shadow and width scales. */
export function tokensCss(tokens: ReferenceTokens): string {
  const { palette } = tokens;
  const lines = [
    `/* Extracted from ${comment(tokens.url)} by design_reference. A starting point: keep the rhythm, change the values. */`,
    ':root {',
    `  --bg: ${palette.background};`,
    `  --surface: ${palette.surface};`,
    `  --text: ${palette.text};`,
    `  --muted: ${palette.muted};`,
    `  --accent: ${palette.accent ?? palette.text};`,
    `  --border: ${palette.border ?? 'rgba(127, 127, 127, 0.25)'};`,
    `  --font-body: ${fontStack(tokens.fonts.body)};`,
    `  --font-heading: ${fontStack(tokens.fonts.heading)};`
  ];
  for (const [role, token] of Object.entries(TYPE_TOKEN)) {
    const style = tokens.type[role];
    if (!style) continue;
    lines.push(`  --size-${token}: ${px(style.size)};`, `  --weight-${token}: ${style.weight};`);
    if (style.lineHeight) lines.push(`  --leading-${token}: ${(style.lineHeight / style.size).toFixed(2).replace(/\.?0+$/, '')};`);
  }
  tokens.spacing.forEach((value, index) => lines.push(`  --space-${index + 1}: ${px(value)};`));
  tokens.radii.forEach((value, index) => lines.push(`  --radius-${['sm', 'md', 'lg', 'xl'][index]}: ${safe(value)};`));
  tokens.shadows.forEach((value, index) => lines.push(`  --shadow-${['sm', 'md', 'lg'][index]}: ${safe(value)};`));
  if (tokens.contentWidth) lines.push(`  --content-width: ${px(tokens.contentWidth)};`);
  if (tokens.gridColumns[0]) lines.push(`  --grid-columns: ${tokens.gridColumns[0]};`);
  lines.push('}', '');
  return lines.join('\n');
}

/** DESIGN.md: the same reading as prose, with the rules a design system needs. */
export function designMd(tokens: ReferenceTokens, date = new Date()): string {
  const { palette, type } = tokens;
  const styleLine = (role: string) => {
    const style = type[role];
    if (!style) return null;
    const leading = style.lineHeight ? `, line height ${style.lineHeight}px` : '';
    return `- ${role === 'p' ? 'Body' : role}: ${px(style.size)}, weight ${style.weight}${leading}, ${style.family || 'system'}`;
  };
  const shades = (entries: Counted<string>[]) => entries.slice(0, 4).map((entry) => `${entry.value} (${entry.count})`).join(', ') || 'none';
  const lines = [
    `# Reference: ${safe(tokens.title) || safe(tokens.url)}`,
    '',
    `Read from ${safe(tokens.url)} on ${date.toISOString().slice(0, 10)}, at ${tokens.width}px wide (${tokens.sampled} elements). A starting point for the look, not a copy of the site: keep the structure and the principles, and never reuse its logo, copy or imagery.`,
    '',
    '## Colour',
    `- text ${palette.text} → --text; muted ${palette.muted} → --muted`,
    `- background ${palette.background} → --bg; surface ${palette.surface} → --surface`,
    `- accent ${palette.accent ?? 'none found'} → --accent; border ${palette.border ?? 'none found'} → --border`,
    `- text shades: ${shades(tokens.shades.text)}`,
    `- background shades: ${shades(tokens.shades.background)}`,
    '',
    '## Typography',
    `- Body font: ${tokens.fonts.body} → --font-body`,
    `- Heading font: ${tokens.fonts.heading} → --font-heading`,
    ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'small', 'button'].map(styleLine).filter((line): line is string => !!line),
    '',
    '## Spacing',
    tokens.spacing.length ? `Scale in px: ${tokens.spacing.join(', ')} (--space-1 to --space-${tokens.spacing.length}).` : 'No spacing scale found; use a 4px base.',
    '',
    '## Shape',
    tokens.radii.length ? `- Radii: ${tokens.radii.join(', ')} (--radius-sm, --radius-md, --radius-lg)` : '- Radii: none found',
    tokens.shadows.length ? `- Shadows: ${tokens.shadows.join(' | ')}` : '- Shadows: none found',
    '',
    '## Layout',
    tokens.contentWidth ? `- Content width about ${tokens.contentWidth}px (--content-width).` : '- No single content width found.',
    tokens.gridColumns.length ? `- Grids of ${tokens.gridColumns.join(' and ')} columns.` : '- No grid columns found.',
    `- ${tokens.sections} section${tokens.sections === 1 ? '' : 's'}${tokens.hasNav ? ', a navigation' : ''}${tokens.hasFooter ? ', a footer' : ''}.`,
    '',
    '## Rules',
    '- Components use these tokens only; add a token when one is missing rather than a magic number.',
    '- Keep the rhythm of the spacing scale and the hierarchy of the type scale.',
    '- Change the palette and the copy for the product at hand.',
    ''
  ];
  return lines.join('\n');
}

/**
 * The reading the model gets back from `design_reference`: short enough to
 * read in one pass, with the values it will reuse in tokens.css.
 */
export function referenceBrief(tokens: ReferenceTokens, notes: { image?: string; saved?: string; system?: string } = {}): string {
  const { palette, type } = tokens;
  const style = (role: string, label = role) => {
    const found = type[role];
    if (!found) return null;
    const leading = found.lineHeight && found.size ? `/${(found.lineHeight / found.size).toFixed(2).replace(/\.?0+$/, '')}` : '';
    return `${label} ${px(found.size)}/${found.weight}${leading}`;
  };
  const families = tokens.fonts.families.map((family) => `${family.value} (${family.count})`).join(', ');
  const lines = [
    `Reference: ${safe(tokens.url)} — "${safe(tokens.title) || 'untitled'}" at ${tokens.width}px wide (${tokens.sampled} elements read).`,
    `Palette: text ${palette.text}, background ${palette.background}, surface ${palette.surface}, muted ${palette.muted}, accent ${palette.accent ?? 'none found'}, border ${palette.border ?? 'none found'}.`,
    `Fonts: body "${tokens.fonts.body}", headings "${tokens.fonts.heading}"${families ? `; in use: ${families}` : ''}.`,
    `Type: ${['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((role) => style(role)).filter(Boolean).join('; ') || 'none found'}; ${[style('p', 'body'), style('small'), style('button', 'button')].filter(Boolean).join('; ') || 'no body text found'}.`,
    `Spacing (px): ${tokens.spacing.join(', ') || 'none found'}.`,
    `Radii: ${tokens.radii.join(', ') || 'none'}. Shadows: ${tokens.shadows.join(' | ') || 'none'}.`,
    `Layout: ${tokens.contentWidth ? `content about ${tokens.contentWidth}px wide` : 'no single content width'}; ${tokens.gridColumns.length ? `grids of ${tokens.gridColumns.join(' and ')} columns` : 'no grids'}; ${tokens.sections} section${tokens.sections === 1 ? '' : 's'}${tokens.hasNav ? ', navigation' : ''}${tokens.hasFooter ? ', footer' : ''}.`
  ];
  if (notes.image) lines.push(`Screenshot: ${notes.image}.`);
  if (notes.saved) lines.push(`Saved: ${notes.saved}.`);
  if (notes.system) lines.push(`Design system: saved as "${safe(notes.system)}". Apply it from the systems list to reuse these tokens.`);
  lines.push('Borrow the structure and principles, not the logo, copy or imagery.');
  return lines.join('\n');
}

/** The host as a file-name stem: `stripe.com` → `stripe-com`. */
export function referenceStem(url: string): string {
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { host = ''; }
  return host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'page';
}

/** The next free `<stem>-<n>.png` among existing names (file names, not paths). */
export function nextReferenceName(stem: string, existing: readonly string[]): string {
  const pattern = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)\\.png$`);
  let highest = 0;
  for (const name of existing) {
    const match = pattern.exec(name);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `${stem}-${highest + 1}.png`;
}

/** A requested viewport width, clamped to what the page script can lay out; anything odd gets the default. */
export function clampReferenceWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return REFERENCE_WIDTH.fallback;
  return clamp(Math.round(value), REFERENCE_WIDTH.min, REFERENCE_WIDTH.max);
}

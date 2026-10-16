/**
 * Flows: which page leads to which, kept per design in `flows.json` at the top of
 * the workspace. The board draws them as quiet arrows between frames; the agent
 * reads and writes the same file when it builds a multi-page flow. Main validates
 * every write (`parseFlowLinks` with `strict`), and a hand-edited or agent-written
 * file is read leniently: a bad entry is dropped, never fatal.
 */

export const DESIGN_FLOWS_FILE = 'flows.json';
export const MAX_FLOW_LINKS = 200;
const PAGE_PATH = /^[A-Za-z0-9._\-/]{1,200}$/;

export interface DesignFlowLink { from: string; to: string }

const isPage = (value: unknown): value is string =>
  typeof value === 'string' && PAGE_PATH.test(value) && !value.includes('..') && !value.startsWith('/') && /\.html?$/i.test(value);

/**
 * The links in a list. Lenient (the default) drops entries that are malformed,
 * self-links, duplicates, or pointing at a page that is not in `pages`; strict
 * throws on the first of those, so a write never half-lands.
 */
export function parseFlowLinks(input: unknown, pages?: readonly string[], strict = false): DesignFlowLink[] {
  const list = Array.isArray(input) ? input : [];
  if (strict && !Array.isArray(input)) throw new Error('links must be a list.');
  if (strict && list.length > MAX_FLOW_LINKS) throw new Error(`A design can hold ${MAX_FLOW_LINKS} links at most.`);
  const known = pages ? new Set(pages) : null;
  const seen = new Set<string>();
  const out: DesignFlowLink[] = [];
  for (const entry of list) {
    const from = (entry as DesignFlowLink | null)?.from;
    const to = (entry as DesignFlowLink | null)?.to;
    const fail = (message: string) => { if (strict) throw new Error(message); };
    if (!isPage(from) || !isPage(to)) { fail('Each link needs a "from" and a "to" page.'); continue; }
    if (from === to) { fail('A page cannot link to itself.'); continue; }
    if (known && (!known.has(from) || !known.has(to))) { fail(`Unknown page in link ${from} → ${to}.`); continue; }
    const id = `${from}\n${to}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ from, to });
    if (out.length >= MAX_FLOW_LINKS) break;
  }
  return out;
}

/** The links in a `flows.json` text: `{ "links": [...] }` or a bare list. Anything unreadable is no links. */
export function parseFlows(text: string | undefined, pages?: readonly string[]): DesignFlowLink[] {
  if (!text) return [];
  try {
    const raw = JSON.parse(text) as unknown;
    return parseFlowLinks(Array.isArray(raw) ? raw : (raw as { links?: unknown } | null)?.links, pages);
  } catch {
    return [];
  }
}

/** The file's text: two-space JSON the agent can read and edit by hand. */
export function serializeFlows(links: readonly DesignFlowLink[]): string {
  return `${JSON.stringify({ links: links.map(({ from, to }) => ({ from, to })) }, null, 2)}\n`;
}

export const hasLink = (links: readonly DesignFlowLink[], from: string, to: string) => links.some((link) => link.from === from && link.to === to);

/** The list with `from → to` added, or removed when it was already there. */
export function toggleLink(links: readonly DesignFlowLink[], from: string, to: string): DesignFlowLink[] {
  if (from === to) return [...links];
  return hasLink(links, from, to) ? links.filter((link) => !(link.from === from && link.to === to)) : [...links, { from, to }];
}

/** The list without the links that touch any page not in `pages` (a page was deleted). */
export function pruneLinks(links: readonly DesignFlowLink[], pages: readonly string[]): DesignFlowLink[] {
  const known = new Set(pages);
  return links.filter((link) => known.has(link.from) && known.has(link.to));
}

interface Box { left: number; top: number; width: number; height: number }

/**
 * A quiet connector between two frames, in the boxes' own coordinates: it leaves
 * the side of `a` that faces `b` and arrives on the facing side of `b`, as a
 * gentle curve. `angle` is the arrow head's direction in degrees.
 */
export function flowPath(a: Box, b: Box): { d: string; x: number; y: number; angle: number } {
  const ac = { x: a.left + a.width / 2, y: a.top + a.height / 2 };
  const bc = { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  const dx = bc.x - ac.x;
  const dy = bc.y - ac.y;
  const sideways = Math.abs(dx) * 0.6 >= Math.abs(dy) || (b.left > a.left + a.width) || (a.left > b.left + b.width);
  let p1: { x: number; y: number };
  let p2: { x: number; y: number };
  let c1: { x: number; y: number };
  let c2: { x: number; y: number };
  if (sideways) {
    const right = dx >= 0;
    p1 = { x: right ? a.left + a.width : a.left, y: ac.y };
    p2 = { x: right ? b.left : b.left + b.width, y: bc.y };
    const pull = Math.max(24, Math.abs(p2.x - p1.x) / 2);
    c1 = { x: p1.x + (right ? pull : -pull), y: p1.y };
    c2 = { x: p2.x + (right ? -pull : pull), y: p2.y };
  } else {
    const down = dy >= 0;
    p1 = { x: ac.x, y: down ? a.top + a.height : a.top };
    p2 = { x: bc.x, y: down ? b.top : b.top + b.height };
    const pull = Math.max(24, Math.abs(p2.y - p1.y) / 2);
    c1 = { x: p1.x, y: p1.y + (down ? pull : -pull) };
    c2 = { x: p2.x, y: p2.y + (down ? -pull : pull) };
  }
  const r = (n: number) => Math.round(n * 10) / 10;
  const angle = Math.round((Math.atan2(p2.y - c2.y, p2.x - c2.x) * 180) / Math.PI);
  return { d: `M${r(p1.x)} ${r(p1.y)}C${r(c1.x)} ${r(c1.y)} ${r(c2.x)} ${r(c2.y)} ${r(p2.x)} ${r(p2.y)}`, x: r(p2.x), y: r(p2.y), angle };
}

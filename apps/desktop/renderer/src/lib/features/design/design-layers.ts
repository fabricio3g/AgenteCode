/**
 * The Layers panel's data: the page's elements as a tree, built from the
 * source HTML (not the live frame), and the keyboard moves over its visible
 * rows. Each node carries a selector the in-frame picker can resolve with
 * `querySelector` (`#id` when unique, else the full path with nth-of-type).
 */
import { findBySelector, scanElements, type SourceElement } from './design-source';

export interface LayerNode {
  /** Resolves to this element in the page. Also the node's key. */
  selector: string;
  /** Index in `scanElements(source)`, to match a picked element back to its row. */
  index: number;
  tag: string;
  /** `tag.class` */
  label: string;
  /** The element's own text, trimmed to a short preview. */
  text: string;
  children: LayerNode[];
}

/** Not worth a row: they draw nothing. */
const HIDDEN = new Set(['head', 'script', 'style', 'link', 'meta', 'title', 'base', 'noscript', 'template']);
/** Drawn as one row; their insides are the element's business. */
const LEAVES = new Set(['svg', 'select', 'textarea', 'canvas', 'iframe', 'video', 'audio']);
const MAX_LAYERS = 1500;
const PREVIEW = 28;
const IDENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** The element's own text (children's text left out), collapsed and cut for a row. */
function ownText(source: string, el: SourceElement, els: SourceElement[]): string {
  let text = '';
  let at = el.openEnd;
  for (const child of el.children.map((i) => els[i])) {
    text += source.slice(at, child.start);
    at = child.end;
  }
  text += source.slice(at, el.contentEnd);
  const plain = text.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  return plain.length > PREVIEW ? `${plain.slice(0, PREVIEW - 1)}…` : plain;
}

function segment(els: SourceElement[], el: SourceElement): string {
  let seg = el.tag;
  for (const name of el.classes.filter((c) => IDENT.test(c)).slice(0, 2)) seg += `.${name}`;
  const siblings = el.parent >= 0 ? els[el.parent].children.map((i) => els[i]) : els.filter((item) => item.parent < 0);
  const same = siblings.filter((item) => item.tag === el.tag);
  if (same.length > 1) seg += `:nth-of-type(${same.indexOf(el) + 1})`;
  return seg;
}

export function buildLayerTree(source: string | undefined): LayerNode[] {
  if (!source) return [];
  const els = scanElements(source);
  const idCounts = new Map<string, number>();
  for (const el of els) if (el.id) idCounts.set(el.id, (idCounts.get(el.id) ?? 0) + 1);
  let budget = MAX_LAYERS;

  const make = (el: SourceElement, path: string[]): LayerNode | null => {
    if (HIDDEN.has(el.tag) || budget <= 0) return null;
    budget -= 1;
    const here = [...path, segment(els, el)];
    const unique = el.id && IDENT.test(el.id) && idCounts.get(el.id) === 1;
    const children = LEAVES.has(el.tag) ? [] : el.children.map((i) => make(els[i], here)).filter((node): node is LayerNode => node !== null);
    const classes = el.classes.find((c) => IDENT.test(c));
    return {
      selector: unique ? `#${el.id}` : here.join(' > '),
      index: el.index,
      tag: el.tag,
      label: el.tag + (classes ? `.${classes}` : ''),
      text: ownText(source, el, els),
      children
    };
  };

  const body = els.find((el) => el.tag === 'body');
  const roots = body ? body.children.map((i) => els[i]) : els.filter((el) => el.parent < 0 && el.tag !== 'html');
  const html = body ? null : els.find((el) => el.tag === 'html');
  const tops = html ? html.children.map((i) => els[i]) : roots;
  return tops.map((el) => make(el, body ? ['html', 'body'] : [])).filter((node): node is LayerNode => node !== null);
}

/** The row an element picked in the frame belongs to: its selector resolved against the source, or null when it is not exactly one element. */
export function layerIndexFor(source: string | undefined, selector: string): number | null {
  if (!source || !selector) return null;
  const found = findBySelector(scanElements(source), selector);
  return found.length === 1 ? found[0].index : null;
}

export interface LayerRow { node: LayerNode; depth: number; open: boolean; parent: number }

/** The default: the page's top-level elements are open (their children show), the rest folded. */
const defaultOpen = (depth: number) => depth < 1;

/** The rows on screen, given which nodes are open (`overrides` by selector; absent = the default for its depth). */
export function visibleRows(tree: LayerNode[], overrides: Record<string, boolean>): LayerRow[] {
  const rows: LayerRow[] = [];
  const walk = (nodes: LayerNode[], depth: number, parent: number) => {
    for (const node of nodes) {
      const open = node.children.length > 0 && (overrides[node.selector] ?? defaultOpen(depth));
      const at = rows.push({ node, depth, open, parent }) - 1;
      if (open) walk(node.children, depth + 1, at);
    }
  };
  walk(tree, 0, -1);
  return rows;
}

/** Ancestors of a node, so a pick deep in the tree can open its way into view. */
export function ancestorSelectors(tree: LayerNode[], index: number): string[] {
  const walk = (nodes: LayerNode[], trail: string[]): string[] | null => {
    for (const node of nodes) {
      if (node.index === index) return trail;
      const found = walk(node.children, [...trail, node.selector]);
      if (found) return found;
    }
    return null;
  };
  return walk(tree, []) ?? [];
}

export interface LayerMove {
  focus: number;
  /** Open or fold the focused row. */
  toggle?: { selector: string; open: boolean };
  /** Select the focused row's element. */
  select?: boolean;
}

/** What a key does on the tree: arrows move, Right opens or enters, Left folds or climbs, Enter selects. Null for any other key. */
export function layerKey(rows: LayerRow[], focus: number, key: string): LayerMove | null {
  if (!rows.length) return null;
  const at = Math.max(0, Math.min(rows.length - 1, focus));
  const row = rows[at];
  const branch = row.node.children.length > 0;
  switch (key) {
    case 'ArrowDown': return { focus: Math.min(rows.length - 1, at + 1) };
    case 'ArrowUp': return { focus: Math.max(0, at - 1) };
    case 'Home': return { focus: 0 };
    case 'End': return { focus: rows.length - 1 };
    case 'ArrowRight':
      if (branch && !row.open) return { focus: at, toggle: { selector: row.node.selector, open: true } };
      return { focus: branch && row.open ? at + 1 : at };
    case 'ArrowLeft':
      if (branch && row.open) return { focus: at, toggle: { selector: row.node.selector, open: false } };
      return { focus: row.parent >= 0 ? row.parent : at };
    case 'Enter':
    case ' ':
      return { focus: at, select: true };
    default: return null;
  }
}

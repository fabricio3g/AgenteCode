/**
 * Reading a page's HTML source without a DOM: the renderer's tests run in
 * node, and an edit needs the element's exact place in the file, which a
 * parsed DOM no longer knows. The scanner below finds every element's opening
 * tag, its children and its extent, well enough for the pages the agent writes
 * (void and raw-text elements, comments, quoted attributes, the common
 * optional end tags). Anything it cannot place exactly is reported as not
 * found, and callers fall back to asking the agent.
 *
 * It serves two features: direct style edits (`planStyleEdit`) and the Layers
 * tree (`design-layers.ts`).
 */

export interface SourceElement {
  index: number;
  /** Lower-case tag name. */
  tag: string;
  id: string;
  classes: string[];
  /** Index of the parent in the scan, or -1 at the top. */
  parent: number;
  children: number[];
  /** Offset of the `<` that opens the element. */
  start: number;
  /** Offset just past the `>` of the opening tag. */
  openEnd: number;
  /** Offset where the content ends (the `<` of the closing tag, or the end of the element). */
  contentEnd: number;
  /** Offset just past the whole element. */
  end: number;
  selfClosing: boolean;
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
/** A new tag closes the open ones listed for it (the common optional end tags). */
const CLOSES: Record<string, string[]> = {
  li: ['li'], dt: ['dt', 'dd'], dd: ['dt', 'dd'], option: ['option'],
  tr: ['td', 'th', 'tr'], td: ['td', 'th'], th: ['td', 'th'],
  thead: ['tbody', 'thead'], tbody: ['thead', 'tbody']
};
const CLOSES_P = new Set(['address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul']);

export interface TagAttribute {
  name: string;
  value: string;
  /** Offsets inside the tag text: the name's first character and just past the value (or quote). */
  start: number;
  end: number;
}

/** The attributes of one opening tag, with their positions inside it. */
export function readAttributes(tag: string): TagAttribute[] {
  const out: TagAttribute[] = [];
  const open = /^<[A-Za-z][^\s/>]*/.exec(tag);
  let i = open ? open[0].length : 0;
  const attribute = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y;
  while (i < tag.length) {
    const char = tag[i];
    if (char === '>' || (char === '/' && tag[i + 1] === '>')) break;
    if (/\s|\//.test(char)) { i += 1; continue; }
    attribute.lastIndex = i;
    const match = attribute.exec(tag);
    if (!match) { i += 1; continue; }
    out.push({ name: match[1].toLowerCase(), value: match[2] ?? match[3] ?? match[4] ?? '', start: i, end: i + match[0].length });
    i += match[0].length;
  }
  return out;
}

/** Where an opening tag that begins at `from` ends (just past `>`), skipping quoted values; -1 when it never closes. */
function tagEnd(source: string, from: number): number {
  let quote = '';
  for (let i = from; i < source.length; i += 1) {
    const char = source[i];
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") quote = char;
    else if (char === '>') return i + 1;
  }
  return -1;
}

/** Every element in document order. */
export function scanElements(source: string): SourceElement[] {
  const out: SourceElement[] = [];
  const stack: number[] = [];
  const closeTop = (at: number) => {
    const el = out[stack.pop() as number];
    el.contentEnd = at;
    el.end = at;
  };
  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt < 0) break;
    if (source.startsWith('<!--', lt)) {
      const close = source.indexOf('-->', lt + 4);
      i = close < 0 ? source.length : close + 3;
      continue;
    }
    if (source[lt + 1] === '!' || source[lt + 1] === '?') {
      const close = source.indexOf('>', lt);
      i = close < 0 ? source.length : close + 1;
      continue;
    }
    if (source[lt + 1] === '/') {
      const close = source.indexOf('>', lt);
      const name = /^<\/([A-Za-z][^\s>]*)/.exec(source.slice(lt, close < 0 ? lt + 80 : close))?.[1]?.toLowerCase();
      const after = close < 0 ? source.length : close + 1;
      i = after;
      if (!name) continue;
      let depth = stack.length - 1;
      while (depth >= 0 && out[stack[depth]].tag !== name) depth -= 1;
      if (depth < 0) continue;
      while (stack.length - 1 > depth) closeTop(lt);
      const el = out[stack.pop() as number];
      el.contentEnd = lt;
      el.end = after;
      continue;
    }
    const named = /^<([A-Za-z][A-Za-z0-9:-]*)/.exec(source.slice(lt, lt + 60));
    if (!named) { i = lt + 1; continue; }
    const tag = named[1].toLowerCase();
    const openEnd = tagEnd(source, lt + named[0].length);
    if (openEnd < 0) break;
    const text = source.slice(lt, openEnd);
    const selfClosing = text.endsWith('/>');

    for (;;) {
      const top = stack.length ? out[stack[stack.length - 1]] : null;
      if (!top) break;
      if (CLOSES[tag]?.includes(top.tag) || (top.tag === 'p' && CLOSES_P.has(tag))) closeTop(lt);
      else break;
    }

    const attrs = readAttributes(text);
    const id = attrs.find((attr) => attr.name === 'id')?.value ?? '';
    const classes = (attrs.find((attr) => attr.name === 'class')?.value ?? '').split(/\s+/).filter(Boolean);
    const parent = stack.length ? stack[stack.length - 1] : -1;
    const el: SourceElement = { index: out.length, tag, id, classes, parent, children: [], start: lt, openEnd, contentEnd: openEnd, end: openEnd, selfClosing };
    out.push(el);
    if (parent >= 0) out[parent].children.push(el.index);

    if (VOID.has(tag) || selfClosing) { i = openEnd; continue; }
    if (RAW.has(tag)) {
      const close = source.toLowerCase().indexOf(`</${tag}`, openEnd);
      if (close < 0) { el.contentEnd = source.length; el.end = source.length; i = source.length; continue; }
      const gt = source.indexOf('>', close);
      el.contentEnd = close;
      el.end = gt < 0 ? source.length : gt + 1;
      i = el.end;
      continue;
    }
    stack.push(el.index);
    i = openEnd;
  }
  while (stack.length) closeTop(source.length);
  return out;
}

interface Segment { tag: string; id: string; classes: string[]; nth: number }

const IDENT = '[A-Za-z_][A-Za-z0-9_-]*';

/** The picker's selector grammar: `#id`, or `tag.class:nth-of-type(n)` segments joined with ` > `. Null for anything else. */
function parseSelector(selector: string): Segment[] | null {
  const parts = selector.trim().split(/\s*>\s*/);
  const out: Segment[] = [];
  for (const part of parts) {
    const match = new RegExp(`^([A-Za-z][A-Za-z0-9-]*)?((?:\\.${IDENT})*)(?:#(${IDENT}))?(?::nth-of-type\\((\\d+)\\))?$|^#(${IDENT})$`).exec(part);
    if (!match || !part) return null;
    if (match[5]) { out.push({ tag: '', id: match[5], classes: [], nth: 0 }); continue; }
    out.push({
      tag: (match[1] ?? '').toLowerCase(),
      id: match[3] ?? '',
      classes: match[2] ? match[2].split('.').filter(Boolean) : [],
      nth: match[4] ? Number(match[4]) : 0
    });
  }
  return out.length ? out : null;
}

function nthOfType(els: SourceElement[], el: SourceElement): number {
  const siblings = el.parent >= 0 ? els[el.parent].children : els.filter((item) => item.parent < 0).map((item) => item.index);
  let n = 0;
  for (const index of siblings) {
    if (els[index].tag === el.tag) n += 1;
    if (index === el.index) break;
  }
  return n;
}

function matches(els: SourceElement[], el: SourceElement, seg: Segment): boolean {
  if (seg.tag && el.tag !== seg.tag) return false;
  if (seg.id && el.id !== seg.id) return false;
  if (seg.classes.some((name) => !el.classes.includes(name))) return false;
  return !seg.nth || nthOfType(els, el) === seg.nth;
}

/** Every element a picker-style selector names. */
export function findBySelector(els: SourceElement[], selector: string): SourceElement[] {
  const segs = parseSelector(selector);
  if (!segs) return [];
  return els.filter((el) => {
    let node: SourceElement | undefined = el;
    for (let s = segs.length - 1; s >= 0; s -= 1) {
      if (!node || !matches(els, node, segs[s])) return false;
      node = node.parent >= 0 ? els[node.parent] : undefined;
    }
    return true;
  });
}

const occurrences = (haystack: string, needle: string) => (needle ? haystack.split(needle).length - 1 : 0);

/**
 * Grows `[start, end)` outward to the smallest span of whole lines that occurs
 * exactly once in the source, so a `design_edit` old_text cannot hit the
 * wrong copy of an identical tag. Null when no span within the cap is unique.
 */
export function uniqueSpan(source: string, start: number, end: number, cap = 900): [number, number] | null {
  let from = start;
  let to = end;
  for (let step = 0; step < 24; step += 1) {
    if (occurrences(source, source.slice(from, to)) === 1) return [from, to];
    if (to - from > cap) return null;
    const canLeft = from > 0;
    const canRight = to < source.length;
    if (!canLeft && !canRight) return null;
    if ((step % 2 === 0 && canLeft) || !canRight) {
      // One line further back.
      const edge = source[from - 1] === '\n' ? from - 1 : from;
      const line = source.lastIndexOf('\n', edge - 1) + 1;
      from = line < from ? line : from - 1;
    } else {
      // One line further on.
      const nl = source.indexOf('\n', source[to] === '\n' ? to + 1 : to);
      to = nl < 0 ? source.length : Math.max(nl, to + 1);
    }
  }
  return null;
}

/** Splits a `style` attribute's text into declarations, honouring parentheses and quotes. */
export function parseStyle(text: string): [string, string][] {
  const out: [string, string][] = [];
  let depth = 0;
  let quote = '';
  let last = 0;
  const push = (end: number) => {
    const raw = text.slice(last, end);
    const colon = raw.indexOf(':');
    if (colon > 0) out.push([raw.slice(0, colon).trim().toLowerCase(), raw.slice(colon + 1).trim()]);
    last = end + 1;
  };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (char === ';' && depth === 0) push(i);
  }
  push(text.length);
  return out;
}

/** `null` removes a property; anything else sets it in place (or at the end). */
export function mergeStyle(existing: string, set: Record<string, string | null>): string {
  const decls = parseStyle(existing);
  for (const [name, value] of Object.entries(set)) {
    const at = decls.findIndex(([item]) => item === name);
    if (value === null) { if (at >= 0) decls.splice(at, 1); continue; }
    if (at >= 0) decls[at] = [name, value]; else decls.push([name, value]);
  }
  return decls.map(([name, value]) => `${name}: ${value}`).join('; ');
}

const SAFE_PROP = /^[a-z][a-z-]*$/;
/** A value that cannot break out of a double-quoted attribute or a declaration. */
const SAFE_VALUE = /^[^"'<>;{}\\\n\r]{1,200}$/;

export type StyleEditPlan =
  | { kind: 'apply'; oldText: string; newText: string }
  | { kind: 'comment'; note: string }
  | { kind: 'none' };

/** The comment the agent gets when an edit cannot be written straight to the source. */
export function styleEditNote(selector: string, set: Record<string, string | null>): string {
  const parts = Object.entries(set).map(([name, value]) => (value === null ? `remove ${name}` : `${name}: ${value}`));
  return `Set ${parts.join('; ')} on ${selector}`;
}

/**
 * Plans a direct change to one element's inline style: the new opening tag,
 * as an exact-once replacement the `design_edit` tool can apply. An element
 * that cannot be found exactly once in the source, or a value that is not
 * safe to write, becomes a comment for the agent instead.
 */
export function planStyleEdit(source: string | undefined, selector: string, set: Record<string, string | null>): StyleEditPlan {
  const note = styleEditNote(selector, set);
  const entries = Object.entries(set);
  if (!entries.length) return { kind: 'none' };
  if (source === undefined) return { kind: 'comment', note };
  if (entries.some(([name, value]) => !SAFE_PROP.test(name) || (value !== null && !SAFE_VALUE.test(value)))) return { kind: 'comment', note };

  const found = findBySelector(scanElements(source), selector);
  if (found.length !== 1) return { kind: 'comment', note };
  const el = found[0];
  const tag = source.slice(el.start, el.openEnd);
  const style = readAttributes(tag).find((attr) => attr.name === 'style');
  const merged = mergeStyle(style?.value ?? '', set);

  let next: string;
  if (style) {
    if (merged) next = tag.slice(0, style.start) + `style="${merged}"` + tag.slice(style.end);
    else {
      // Nothing left: drop the attribute with the space before it.
      let from = style.start;
      while (from > 0 && /\s/.test(tag[from - 1])) from -= 1;
      next = tag.slice(0, from) + tag.slice(style.end);
    }
  } else {
    if (!merged) return { kind: 'none' };
    const close = tag.endsWith('/>') ? tag.length - 2 : tag.length - 1;
    let at = close;
    while (at > 0 && /\s/.test(tag[at - 1])) at -= 1;
    next = tag.slice(0, at) + ` style="${merged}"` + tag.slice(at);
  }
  if (next === tag) return { kind: 'none' };

  const span = uniqueSpan(source, el.start, el.openEnd);
  if (!span) return { kind: 'comment', note };
  const before = source.slice(span[0], el.start);
  const after = source.slice(el.openEnd, span[1]);
  return { kind: 'apply', oldText: before + tag + after, newText: before + next + after };
}

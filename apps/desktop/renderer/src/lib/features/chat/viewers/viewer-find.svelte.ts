/** DOM text search never rewrites rendered HTML, links or syntax markup. */
import { readerScrollBehavior } from './pan-scroll';
import { untrack } from 'svelte';

export function findTextRanges(root: HTMLElement, query: string): Range[] {
  const needle = query.trim();
  if (!needle) return [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => node.parentElement?.closest('script,style,textarea,input,[data-no-find]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nodes: Array<{ node: Node; start: number; end: number }> = [];
  let content = '';
  let block: Element | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const next = node.parentElement?.closest('p,li,h1,h2,h3,h4,h5,h6,pre,td,th') || root;
    if (block && block !== next) content += '\n';
    block = next;
    const start = content.length; content += node.textContent || ''; nodes.push({ node, start, end: content.length });
  }
  const expression = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const ranges: Range[] = [];
  for (const hit of content.matchAll(expression)) {
    const start = hit.index!, end = start + hit[0].length;
    const first = nodes.find((node) => node.end > start), last = nodes.find((node) => node.start < end && node.end >= end);
    if (!first || !last || first.start > start || last.end < end) continue;
    const range = document.createRange();
    range.setStart(first.node, start - first.start); range.setEnd(last.node, end - last.start); ranges.push(range);
  }
  return ranges;
}

/** One search owner for each readable surface; late DOM loads are observed. */
export function createViewerFind(target: () => HTMLElement | undefined | null, query: () => string) {
  const id = `viewer-find-${crypto.randomUUID()}`, activeId = `${id}-active`;
  const state = $state({ matches: 0, index: 0 });
  let ranges: Range[] = [];
  const registry = () => typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined' ? CSS.highlights : null;
  function show(scroll: boolean) {
    const hit = ranges[state.index];
    const highlights = registry();
    highlights?.delete(activeId);
    if (hit) {
      highlights?.set(activeId, new Highlight(hit));
      if (scroll) hit.startContainer.parentElement?.scrollIntoView?.({ block: 'center', behavior: readerScrollBehavior() });
    }
  }
  function step(direction: 1 | -1) {
    if (!ranges.length) return;
    select((state.index + direction + ranges.length) % ranges.length);
  }
  function select(index: number, scroll = true) {
    if (!ranges.length) return;
    state.index = Math.max(0, Math.min(ranges.length - 1, index)); show(scroll);
  }
  $effect(() => {
    const node = target(), needle = query();
    state.index = 0;
    const refresh = () => untrack(() => {
      const before = ranges.length;
      ranges = node ? findTextRanges(node, needle) : []; state.matches = ranges.length;
      state.index = Math.min(state.index, Math.max(0, ranges.length - 1));
      const highlights = registry(); highlights?.delete(id);
      if (ranges.length) highlights?.set(id, new Highlight(...ranges));
      show(before === 0 && ranges.length > 0);
    });
    refresh();
    const observer = node && typeof MutationObserver !== 'undefined' ? new MutationObserver(refresh) : null;
    if (node) observer?.observe(node, { childList: true, subtree: true, characterData: true });
    return () => { observer?.disconnect(); registry()?.delete(id); registry()?.delete(activeId); ranges = []; };
  });
  $effect(() => {
    const style = document.createElement('style');
    style.textContent = `::highlight(${id}){background:color-mix(in srgb,var(--primary) 22%,transparent)}::highlight(${activeId}){background:color-mix(in srgb,var(--primary) 42%,transparent)}`;
    document.head.append(style); return () => style.remove();
  });
  return { state, step, select };
}

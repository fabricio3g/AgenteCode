/** One compiled pattern per cast: replies re-render on every streamed chunk. */
const patterns = new Map<string, RegExp | null>();

function mentionPattern(names: string[]): RegExp | null {
  const key = names.join('\u0000');
  if (!patterns.has(key)) {
    const candidates = [...new Set(names.map((name) => name.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
    const escaped = candidates.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    if (patterns.size > 32) patterns.clear();
    patterns.set(key, candidates.length ? new RegExp(`(^|[^\\p{L}\\p{N}\\p{M}_])(@?(?:${escaped}))(?=$|[^\\p{L}\\p{N}\\p{M}_])`, 'giu') : null);
  }
  return patterns.get(key)!;
}

/** Decorate rendered text only: never touch links, code or HTML attributes. */
export function highlightRoleplayMentions(html: string, names: string[]): string {
  if (!names.length || !html || typeof document === 'undefined') return html;
  const pattern = mentionPattern(names);
  if (!pattern) return html;
  // No name anywhere in the markup: nothing to decorate, skip the DOM work.
  pattern.lastIndex = 0;
  if (!pattern.test(html)) return html;
  pattern.lastIndex = 0;
  const template = document.createElement('template');
  template.innerHTML = html;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.parentElement?.closest('a, code, pre, .roleplay-mention')) nodes.push(node);
  }
  for (const node of nodes) {
    const text = node.textContent ?? '';
    const matches = [...text.matchAll(pattern)];
    if (!matches.length) continue;
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const match of matches) {
      const start = match.index! + match[1].length;
      fragment.append(document.createTextNode(text.slice(offset, start)));
      const span = document.createElement('span');
      span.className = 'roleplay-mention';
      span.textContent = match[2];
      fragment.append(span);
      offset = start + match[2].length;
    }
    fragment.append(document.createTextNode(text.slice(offset)));
    node.replaceWith(fragment);
  }
  return template.innerHTML;
}

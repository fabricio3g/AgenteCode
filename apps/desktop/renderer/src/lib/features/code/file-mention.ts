// `@path` in the Code composer: find the mention being typed and the
// project files it could be, best matches first.

export interface FileMention {
  /** Index of the `@`. */
  start: number;
  query: string;
}

/** The `@mention` the caret is at the end of, if any. */
export function fileMentionAt(text: string, caret: number): FileMention | null {
  const match = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  return match ? { start: caret - match[2].length - 1, query: match[2] } : null;
}

/** Files whose name starts with the query, then whose path contains it; shorter paths first. */
export function matchFiles(files: readonly string[], query: string, limit = 8): string[] {
  const q = query.toLowerCase();
  const byLength = (a: string, b: string) => a.length - b.length || a.localeCompare(b);
  if (!q) return [...files].sort(byLength).slice(0, limit);
  const name = (file: string) => file.slice(file.lastIndexOf('/') + 1).toLowerCase();
  const first = files.filter((file) => name(file).startsWith(q)).sort(byLength);
  const rest = files.filter((file) => !name(file).startsWith(q) && file.toLowerCase().includes(q)).sort(byLength);
  return [...first, ...rest].slice(0, limit);
}

/** Put `@path ` in place of the mention; returns the text and the caret after it. */
export function insertFile(text: string, caret: number, mention: FileMention, file: string): { text: string; caret: number } {
  const inserted = /\s/.test(file) ? `@"${file}" ` : `@${file} `;
  const rest = text.slice(caret).replace(/^[^\s]*\s?/, '');
  return { text: text.slice(0, mention.start) + inserted + rest, caret: mention.start + inserted.length };
}

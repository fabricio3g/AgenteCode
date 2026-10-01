// A unified diff as rows to paint: the `---`/`+++` header dropped, each hunk
// numbering its old and new lines, a gap marker between hunks.

export type PatchRow = { kind: 'add' | 'del' | 'ctx' | 'hunk'; text: string; oldNo?: number; newNo?: number };

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Whether text reads as a diff (and should render as one). */
export function looksLikePatch(text: string): boolean {
  return /^(---|\+\+\+|@@)/m.test(text);
}

/** Line counters of the hunk being read; undefined before any hunk (a bare +/- listing). */
type Cursor = { oldNo?: number; newNo?: number; inHunk: boolean };

/** The current line number on one side, then step past it. */
function take(at: Cursor, side: 'oldNo' | 'newNo'): number | undefined {
  const value = at[side];
  if (value !== undefined) at[side] = value + 1;
  return value;
}

function bodyRow(line: string, at: Cursor): PatchRow | null {
  if (line.startsWith('\\')) return null; // "\ No newline at end of file"
  if (line.startsWith('+')) return { kind: 'add', text: line.slice(1), newNo: take(at, 'newNo') };
  if (line.startsWith('-')) return { kind: 'del', text: line.slice(1), oldNo: take(at, 'oldNo') };
  if (!at.inHunk && !line) return null;
  return { kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line, oldNo: take(at, 'oldNo'), newNo: take(at, 'newNo') };
}

export function parsePatch(patch: string): PatchRow[] {
  const rows: PatchRow[] = [];
  const at: Cursor = { inHunk: false };
  for (const line of patch.split('\n')) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      if (at.inHunk) rows.push({ kind: 'hunk', text: line });
      Object.assign(at, { inHunk: true, oldNo: Number(hunk[1]), newNo: Number(hunk[2]) });
      continue;
    }
    // File headers come before the first hunk only; later `---` is a removed line.
    if (!at.inHunk && /^(---|\+\+\+)/.test(line)) continue;
    const row = bodyRow(line, at);
    if (row) rows.push(row);
  }
  return rows;
}

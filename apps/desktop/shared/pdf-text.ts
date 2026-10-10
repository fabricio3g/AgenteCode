/** Positioned PDF runs: shared by native indexing, the reader and OCR fallback. */
export function pdfTextLines(items: Array<{ str?: string; transform?: number[]; width?: number }>): string[] {
  const rows = new Map<number, Array<{ x: number; w: number; s: string }>>();
  for (const item of items) {
    if (!item.str || !item.transform) continue;
    const y = Math.round(item.transform[5] / 3);
    const row = rows.get(y) || [];
    row.push({ x: item.transform[4], w: item.width || 0, s: item.str }); rows.set(y, row);
  }
  return [...rows.entries()].sort((a, b) => b[0] - a[0]).map(([, parts]) => {
    parts.sort((a, b) => a.x - b.x);
    let line = '', end = 0;
    for (const part of parts) {
      if (line) line += part.x - end > 12 ? '\t' : part.x - end > 1 ? ' ' : '';
      line += part.s; end = part.x + part.w;
    }
    return line.trim();
  }).filter(Boolean);
}

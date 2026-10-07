/**
 * Markdown → retrieval chunks.
 *
 * Every chunk remembers where it came from: the heading trail above it (which
 * is also the citation — the converters emit `## Page 3`, `## Slide 2: …` and
 * `## Sheet 1: Sales` headings) and the source line range. Fenced code is split
 * on line boundaries, never on sentence punctuation, so a `"…."` inside a
 * string no longer cuts a statement in half. Consecutive chunks of the same
 * section share a short overlap so an answer straddling a boundary survives.
 */

export type Chunk = {
  /** Body text; empty when the section was a heading with nothing under it. */
  text: string;
  /** Heading trail, outermost first, joined with ` › `; empty before any heading. */
  heading: string;
  /** 1-based, inclusive, in the normalized Markdown. */
  lineStart: number;
  lineEnd: number;
};

export type ChunkOptions = {
  /** Target size in characters. */
  size?: number;
  /** Characters of trailing context repeated at the start of the next chunk. */
  overlap?: number;
};

type Piece = { text: string; lineStart: number; lineEnd: number; code: boolean };
type Section = { heading: string; pieces: Piece[]; line: number };

const DEFAULT_SIZE = 900;
const MIN_SIZE = 128;

export function chunkMarkdown(input: string, options: ChunkOptions = {}): Chunk[] {
  const size = Math.max(MIN_SIZE, Number(options.size) || DEFAULT_SIZE);
  const overlap = Math.min(Math.max(0, options.overlap ?? Math.round(size * 0.15)), Math.floor(size / 2));
  const text = String(input || '').replace(/\r\n?/g, '\n');
  if (!text.trim()) return [];

  const chunks: Chunk[] = [];
  for (const section of splitSections(text)) {
    const pieces = section.pieces.flatMap((piece) => splitOversized(piece, size));
    const before = chunks.length;
    packSection(section.heading, pieces, size, overlap, chunks);
    // A heading with no body — a title slide, a section divider — is still a
    // retrievable unit. Dropping it loses the deck's outline from the index.
    if (chunks.length === before && section.heading) {
      chunks.push({ text: '', heading: section.heading, lineStart: section.line, lineEnd: section.line });
    }
  }
  return chunks;
}

/** Text a chunk is embedded and keyword-indexed as: its heading trail gives it context. */
export function searchableText(chunk: { text: string; heading?: string }): string {
  return chunk.heading ? `${chunk.heading}\n\n${chunk.text}` : chunk.text;
}

/**
 * A locator the converters stamped into the heading trail. `page` and `slide`
 * numbers and `sheet` names are derived from the marker itself, so citations
 * survive chunking without a second metadata channel.
 */
export type ChunkAnchor = { kind: 'page' | 'slide' | 'sheet'; index: number; title: string };

/**
 * Innermost locator of a heading trail: `Report › Page 3` is page 3. Returns
 * null for ordinary document headings, which are cited by name instead.
 */
export function anchorOf(heading: string): ChunkAnchor | null {
  const titles = String(heading || '').split(' › ');
  for (let i = titles.length - 1; i >= 0; i--) {
    const title = titles[i].trim();
    const page = title.match(/^Page\s+(\d+)$/i);
    if (page) return { kind: 'page', index: Number(page[1]), title: '' };
    const slide = title.match(/^Slide\s+(\d+)(?::\s*(.*))?$/i);
    if (slide) return { kind: 'slide', index: Number(slide[1]), title: (slide[2] || '').trim() };
    const sheet = title.match(/^Sheet\s+(\d+)(?::\s*(.*))?$/i);
    if (sheet) return { kind: 'sheet', index: Number(sheet[1]), title: (sheet[2] || '').trim() };
  }
  return null;
}

/**
 * Spreadsheet rows carry their Excel row number in the leading `#` column
 * (`| 12 | North | 100 |`), so a chunk can say which rows it covers even after
 * a table was split and its header repeated.
 */
export function rowRangeOf(text: string): { first: number; last: number } | null {
  let first = 0;
  let last = 0;
  for (const line of String(text || '').split('\n')) {
    const match = line.match(/^\|\s*(\d+)\s*\|/);
    if (!match) continue;
    if (!first) first = Number(match[1]);
    last = Number(match[1]);
  }
  return first ? { first, last } : null;
}

function splitSections(text: string): Section[] {
  const lines = text.split('\n');
  const sections: Section[] = [];
  const trail: Array<{ level: number; title: string }> = [];
  let section: Section = { heading: '', pieces: [], line: 1 };
  let block: string[] = [];
  let blockStart = 0;
  let fence: string | null = null;

  const flushBlock = (endLine: number, code = false) => {
    if (block.some((line) => line.trim())) {
      section.pieces.push({ text: trimBlankEdges(block).join('\n'), lineStart: blockStart, lineEnd: endLine, code });
    }
    block = [];
  };

  lines.forEach((line, i) => {
    const lineNo = i + 1;
    const fenceMatch = line.trimStart().match(/^(```+|~~~+)/);

    if (fence) {
      block.push(line);
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
        fence = null;
        flushBlock(lineNo, true);
      }
      return;
    }

    if (fenceMatch) {
      flushBlock(lineNo - 1);
      fence = fenceMatch[1];
      block = [line];
      blockStart = lineNo;
      return;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushBlock(lineNo - 1);
      if (section.pieces.length || section.heading) sections.push(section);
      const level = heading[1].length;
      while (trail.length && trail[trail.length - 1].level >= level) trail.pop();
      trail.push({ level, title: heading[2] });
      section = { heading: trail.map((entry) => entry.title).join(' › '), pieces: [], line: lineNo };
      return;
    }

    if (!line.trim()) {
      flushBlock(lineNo - 1);
      return;
    }

    if (!block.length) blockStart = lineNo;
    block.push(line);
  });

  // An unterminated fence still keeps its lines as code.
  flushBlock(lines.length, fence !== null);
  if (section.pieces.length || section.heading) sections.push(section);
  return sections;
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start++;
  while (end > start && !lines[end - 1].trim()) end--;
  return lines.slice(start, end);
}

function splitOversized(piece: Piece, size: number): Piece[] {
  if (piece.text.length <= size) return piece.code ? [stripFenceLines(piece)] : [piece];
  return piece.code ? splitCode(piece, size) : splitProse(piece, size);
}

/**
 * A fenced chunk's reported lines are the code's lines, not the fence's: the
 * opening fence sits above line 1 of the file and the closing one below its last
 * line, so citing the raw Markdown range pointed a reader at the wrong place.
 */
function stripFenceLines(piece: Piece): Piece {
  const lines = piece.text.split('\n');
  if (lines.length < 2 || !/^\s*(```+|~~~+)/.test(lines[0])) return piece;
  const closes = /^\s*(```+|~~~+)\s*$/.test(lines[lines.length - 1]);
  const lineStart = piece.lineStart + 1;
  const lineEnd = Math.max(lineStart, piece.lineEnd - (closes ? 1 : 0));
  return { ...piece, lineStart, lineEnd };
}

/** Split fenced code on line boundaries; each part is re-fenced so it stays valid Markdown. */
function splitCode(piece: Piece, size: number): Piece[] {
  const lines = piece.text.split('\n');
  const opener = lines[0];
  const closer = /^\s*(```+|~~~+)\s*$/.test(lines[lines.length - 1]) ? lines.pop()! : null;
  const fenceWrap = (body: string[]) => [opener, ...body, closer ?? opener.trimStart().match(/^(```+|~~~+)/)![1]].join('\n');
  const budget = Math.max(MIN_SIZE / 2, size - opener.length - 8);

  const parts: Piece[] = [];
  let body: string[] = [];
  let bodyLen = 0;
  let bodyStart = piece.lineStart + 1;

  const flush = (endLine: number) => {
    if (!body.length) return;
    parts.push({ text: fenceWrap(body), lineStart: bodyStart, lineEnd: endLine, code: true });
    body = [];
    bodyLen = 0;
  };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = piece.lineStart + i;
    if (bodyLen + line.length + 1 > budget && body.length) {
      flush(lineNo - 1);
      bodyStart = lineNo;
    }
    // A single enormous line (minified code) is hard-cut; there is nothing better.
    for (const slice of hardCut(line, budget)) {
      if (bodyLen + slice.length + 1 > budget && body.length) {
        flush(lineNo);
        bodyStart = lineNo;
      }
      body.push(slice);
      bodyLen += slice.length + 1;
    }
  }
  // `lines` no longer holds the closing fence, so the last body line is the last
  // element — not `piece.lineEnd`, which still points at the closer.
  flush(piece.lineStart + lines.length - 1);
  return parts;
}

/**
 * Split prose on line boundaries first (lists and tables keep their rows), then
 * on sentences for lines that are themselves too long. A split table repeats its
 * header row so every part still reads as a table.
 */
function splitProse(piece: Piece, size: number): Piece[] {
  const lines = piece.text.split('\n');
  const isTable = lines.length > 2 && /^\s*\|/.test(lines[0]) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[1]);
  const header = isTable ? `${lines[0]}\n${lines[1]}` : '';
  const rows = isTable ? lines.slice(2) : lines;
  const budget = isTable ? Math.max(MIN_SIZE / 2, size - header.length - 1) : size;

  const parts: Piece[] = [];
  let current: string[] = [];
  let length = 0;
  let lineNo = piece.lineStart + (isTable ? 2 : 0);
  let start = lineNo;
  let end = lineNo;

  const flush = () => {
    if (!current.length) return;
    const body = current.join('\n');
    parts.push({ text: header ? `${header}\n${body}` : body, lineStart: start, lineEnd: end, code: false });
    current = [];
    length = 0;
  };

  for (const row of rows) {
    const units = row.length <= budget
      ? [row]
      : row.split(/(?<=[.!?。！？])\s+/).flatMap((sentence) => hardCut(sentence, budget));
    for (const unit of units) {
      if (current.length && length + unit.length + 1 > budget) {
        flush();
        start = lineNo;
      }
      current.push(unit);
      length += unit.length + 1;
      end = lineNo;
    }
    lineNo++;
  }
  flush();
  return parts;
}

function hardCut(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function packSection(heading: string, pieces: Piece[], size: number, overlap: number, out: Chunk[]): void {
  let current: Piece[] = [];
  let length = 0;

  const emit = () => {
    if (!current.length) return;
    out.push({
      text: current.map((piece) => piece.text).join('\n\n'),
      heading,
      lineStart: Math.min(...current.map((piece) => piece.lineStart)),
      lineEnd: Math.max(...current.map((piece) => piece.lineEnd))
    });
  };

  for (const piece of pieces) {
    if (current.length && length + piece.text.length + 2 > size) {
      emit();
      // Carry the trailing pieces that fit in the overlap budget (whole pieces only,
      // so a carried line is never cut mid-word).
      const carried: Piece[] = [];
      let carriedLen = 0;
      for (let i = current.length - 1; i >= 0; i--) {
        const candidate = current[i];
        if (candidate.code || carriedLen + candidate.text.length > overlap) break;
        carried.unshift(candidate);
        carriedLen += candidate.text.length + 2;
      }
      current = carried;
      length = carriedLen;
    }
    current.push(piece);
    length += piece.text.length + 2;
  }
  emit();
}

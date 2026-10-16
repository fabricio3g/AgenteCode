/**
 * Freehand marks on the board. A mark is a list of points in page coordinates
 * (so it follows its frame's scroll), drawn on a screen layer; to reach the
 * agent it becomes text — a bounding box and the elements it crosses, which
 * the frame answers for (`probe`). Pure helpers only: no pixels leave the app.
 */
import type { DesignStroke } from '$shared/design';

export interface Pt { x: number; y: number }

/** A probe samples at most this many points along a mark. */
export const PROBE_POINTS = 16;
/** A mark smaller than this (px, either way) is a click, not a drawing. */
export const MIN_MARK = 6;
export const MAX_STROKES = 12;
/** Points closer than this (screen px) to the last one are dropped while drawing. */
export const POINT_GAP = 2;

/** Whether a drawn path is big enough to keep. */
export function isMark(points: Pt[], min = MIN_MARK): boolean {
  if (points.length < 2) return false;
  const box = strokeBox(points);
  return Math.max(box.width, box.height) >= min;
}

export function strokeBox(points: Pt[]): { x: number; y: number; width: number; height: number } {
  if (!points.length) return { x: 0, y: 0, width: 0, height: 0 };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(Math.max(...xs) - x), height: Math.round(Math.max(...ys) - y) };
}

/** Up to `count` points spread evenly along the path, ends included. */
export function samplePoints(points: Pt[], count = PROBE_POINTS): Pt[] {
  if (points.length <= count) return points;
  const out: Pt[] = [];
  for (let i = 0; i < count; i += 1) out.push(points[Math.round((i * (points.length - 1)) / (count - 1))]);
  return out;
}

/**
 * The selectors a mark crossed, most frequent first. `html` and `body` only
 * count when nothing more specific was hit, since every mark is over them.
 */
export function rankHits(hits: string[][], limit = 4): string[] {
  const counts = new Map<string, number>();
  for (const point of hits) for (const selector of new Set(point)) counts.set(selector, (counts.get(selector) ?? 0) + 1);
  const order = [...counts.keys()];
  const sorted = order.sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || order.indexOf(a) - order.indexOf(b));
  const specific = sorted.filter((selector) => selector !== 'html' && selector !== 'body');
  return (specific.length ? specific : sorted).slice(0, limit);
}

/** SVG `points` for a mark, relative to its frame's top-left: page px minus the scroll, times the board's scale. */
export function screenPoints(points: Pt[], scroll: Pt, scale: number): string {
  return points.map((p) => `${round((p.x - scroll.x) * scale)},${round((p.y - scroll.y) * scale)}`).join(' ');
}

const round = (n: number) => Math.round(n * 10) / 10;

/** The "Marks drawn on the canvas" block of a turn's context. */
export function formatMarks(strokes: DesignStroke[]): string[] {
  const lines = [
    '',
    '## Marks drawn on the canvas',
    'The user drew these freehand marks to point at something (circling, underlining, an arrow). Each is a bounding box in page pixels and the elements it crosses; read the message to see what the mark asks for.'
  ];
  strokes.forEach((stroke, index) => {
    const box = strokeBox(stroke.points);
    const over = stroke.hits?.length ? `, over ${stroke.hits.map((selector) => `\`${selector}\``).join(', ')}` : '';
    lines.push(`${index + 1}. ${stroke.page}${stroke.width ? ` at ${stroke.width}px` : ''}: freehand mark ${box.width}×${box.height} at ${box.x},${box.y}${over}`);
  });
  return lines;
}

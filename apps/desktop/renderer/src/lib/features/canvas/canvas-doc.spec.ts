import { describe, expect, it } from 'vitest';
import {
  asFractions,
  blankBoard,
  boundsOf,
  composePrompt,
  formatFraction,
  isBlankBoard,
  isPoint,
  marksFor,
  mergeDraft,
  moveMark,
  normalizeBox,
  padded,
  planHandoff,
  resizeMark,
  withMark,
  withoutMark,
  type CanvasDoc,
  type CanvasImage,
  type CanvasMark
} from './canvas-doc';

const image: CanvasImage = { id: 'img1', path: '/root/.agente/attachments/a.png', name: 'shot.png', w: 1000, h: 500 };

function mark(over: Partial<CanvasMark> = {}): CanvasMark {
  return { id: 'm1', imageId: 'img1', kind: 'rect', x: 100, y: 40, w: 300, h: 100, color: '#ef4444', width: 4, opacity: 1, ...over };
}

function doc(over: Partial<CanvasDoc> = {}): CanvasDoc {
  return { images: [image], marks: [], view: { zoom: 1, panX: 0, panY: 0 }, labelled: [], ...over };
}

describe('geometry in image pixels', () => {
  it('normalizes a drag from any corner', () => {
    expect(normalizeBox({ x: 300, y: 200 }, { x: 100, y: 40 })).toEqual({ x: 100, y: 40, w: 200, h: 160 });
    expect(normalizeBox({ x: 100, y: 40 }, { x: 300, y: 200 })).toEqual({ x: 100, y: 40, w: 200, h: 160 });
  });

  it('bounds a freehand stroke by its extremes', () => {
    expect(boundsOf([[10, 90], [40, 20], [70, 60]])).toEqual({ x: 10, y: 20, w: 60, h: 70 });
    expect(boundsOf([])).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it('never lets a mark leave the image', () => {
    const pushed = resizeMark(mark(), { x: 900, y: 480, w: 400, h: 400 }, image);
    expect(pushed.x + pushed.w).toBeLessThanOrEqual(image.w);
    expect(pushed.y + pushed.h).toBeLessThanOrEqual(image.h);
    const dragged = moveMark(mark(), { x: 100, y: 40 }, { x: -500, y: -500 }, image);
    expect(dragged.x).toBe(0);
    expect(dragged.y).toBe(0);
  });

  it('keeps a mark addressable across add, replace and remove', () => {
    const one = withMark([], mark());
    expect(one).toHaveLength(1);
    expect(withMark(one, mark({ x: 7 }))[0]!.x).toBe(7);
    expect(withMark(one, mark({ x: 7 }))).toHaveLength(1);
    expect(withoutMark(one, 'm1')).toEqual([]);
  });
});

describe('what the agent is told', () => {
  it('emits fractions of image size, not pixels', () => {
    expect(asFractions({ x: 120, y: 40, w: 490, h: 95 }, image)).toEqual({ x: 0.12, y: 0.08, w: 0.49, h: 0.19 });
    expect(formatFraction(0.124)).toBe('0.12');
    expect(formatFraction(1 / 3)).toBe('0.33');
  });

  it('pads a crop but keeps it inside the bitmap', () => {
    expect(padded({ x: 0, y: 0, w: 10, h: 10 }, 12, image)).toEqual({ x: 0, y: 0, w: 22, h: 22 });
    const edge = padded({ x: 990, y: 490, w: 10, h: 10 }, 12, image);
    expect(edge.x + edge.w).toBe(1000);
    expect(edge.y + edge.h).toBe(500);
  });

  it('crops only points that carry an instruction', () => {
    const board = doc({ marks: [mark({ id: 'labelled' }), mark({ id: 'bare' }), mark({ id: 'text', kind: 'text' })], labelled: ['labelled'] });
    const plan = planHandoff(board);
    expect(plan.overview).toHaveLength(1);
    // The overview carries every mark, including the unlabelled and the text.
    expect(plan.overview[0]!.marks).toHaveLength(3);
    expect(plan.overview[0]!.box).toBeNull();
    expect(plan.points.map((point) => point.marks[0]!.id)).toEqual(['labelled']);
    expect(plan.points[0]!.box).not.toBeNull();
  });

  it('sends nothing when the board is empty', () => {
    const prompt = composePrompt([], [], 'HEADER', 'EMPTY');
    expect(prompt).toEqual({ text: 'EMPTY', fileCount: 0 });
  });

  it('names every point with its label, shape and region', () => {
    const prompt = composePrompt(
      ['/root/.agente/attachments/full.png'],
      // Fractions are per-axis: 95/500 is 0.19 tall, but its bottom edge lands
      // at 135/500, which is 0.27. A square assumption here would lie.
      [{ label: 'nav overflows here', kind: 'rect', box: asFractions({ x: 120, y: 40, w: 490, h: 95 }, image), path: '/root/.agente/attachments/crop1.png' }],
      'HEADER',
      'EMPTY'
    );
    expect(prompt.text).toBe(
      'HEADER\n\nOverall: @/root/.agente/attachments/full.png.\n\n1. "nav overflows here" — rect at (0.12, 0.08)–(0.61, 0.27) — @/root/.agente/attachments/crop1.png'
    );
    expect(prompt.fileCount).toBe(2);
  });

  it('counts an overview but no points when nothing was labelled', () => {
    const prompt = composePrompt(['/a.png'], [], 'HEADER', 'EMPTY');
    expect(prompt.fileCount).toBe(1);
    expect(prompt.text).toBe('HEADER\n\nOverall: @/a.png.');
  });
});

describe('draft merge', () => {
  it('leaves an empty draft alone', () => {
    expect(mergeDraft('', 'ADDED')).toBe('ADDED');
    expect(mergeDraft('   \n', 'ADDED')).toBe('ADDED');
  });

  it('keeps what was already written', () => {
    expect(mergeDraft('fix the header', 'ADDED')).toBe('fix the header\n\nADDED');
    expect(mergeDraft('fix the header\n', 'ADDED')).toBe('fix the header\n\nADDED');
  });
});

describe('which marks can point', () => {
  it('treats a region as a point and a decoration as not', () => {
    for (const kind of ['rect', 'ellipse', 'arrow', 'line', 'freehand'] as const) expect(isPoint(mark({ kind }))).toBe(true);
    for (const kind of ['text', 'highlight', 'blur'] as const) expect(isPoint(mark({ kind }))).toBe(false);
  });

  it('scopes marks to their own image', () => {
    const board = doc({ marks: [mark(), mark({ id: 'm2', imageId: 'other' })] });
    expect(marksFor(board, 'img1').map((item) => item.id)).toEqual(['m1']);
    expect(marksFor(board, 'missing')).toEqual([]);
  });
});

describe('a board painted from scratch', () => {
  const paper: CanvasImage = { id: 'board1', name: 'whiteboard.png', w: 1600, h: 1000 };

  it('is an image record with no attachment behind it', () => {
    expect(isBlankBoard(paper)).toBe(true);
    expect(isBlankBoard(image)).toBe(false);
    expect(blankBoard('whiteboard.png')).toEqual({ name: 'whiteboard.png', w: 1600, h: 1000 });
  });

  it('plans an overview and crops points exactly like a bitmap board', () => {
    const board = doc({
      images: [paper],
      marks: [mark({ id: 'm1', imageId: 'board1', kind: 'freehand', x: 10, y: 20, w: 100, h: 60 }), mark({ id: 'm2', imageId: 'board1' })],
      labelled: ['m1']
    });
    const plan = planHandoff(board);
    expect(plan.overview).toEqual([{ imageId: 'board1', box: null, marks: [board.marks[0], board.marks[1]] }]);
    expect(plan.points).toHaveLength(1);
    expect(plan.points[0]!.box).toEqual({ x: 0, y: 8, w: 122, h: 84 });
  });

  it('measures crops against the paper size', () => {
    const area = asFractions({ x: 800, y: 500, w: 400, h: 250 }, paper);
    expect(area).toEqual({ x: 0.5, y: 0.5, w: 0.25, h: 0.25 });
    expect(padded({ x: 0, y: 0, w: 20, h: 20 }, 12, paper)).toEqual({ x: 0, y: 0, w: 32, h: 32 });
  });
});

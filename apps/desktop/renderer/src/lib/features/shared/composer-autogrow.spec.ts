// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { MAX_COMPOSER_TEXTAREA_PX, autogrowTextarea } from './composer-autogrow';

/** The shape `autogrowTextarea` actually touches; jsdom never lays out, so a
 *  real textarea would report a zero width for every case. */
function field({ width, value, scrollHeight, lineHeight = 24 }: { width: number; value: string; scrollHeight: number; lineHeight?: number }) {
  const element = {
    isConnected: true,
    clientWidth: width,
    scrollHeight,
    value,
    style: { height: '' },
    ownerDocument: {
      defaultView: { getComputedStyle: () => ({ lineHeight: `${lineHeight}px`, maxHeight: '' }) }
    }
  };
  return element as unknown as HTMLTextAreaElement & { style: { height: string } };
}

describe('composer autogrow', () => {
  it('sizes the field to its content', () => {
    const element = field({ width: 400, value: 'Two lines\nof text', scrollHeight: 64 });
    autogrowTextarea(element);
    expect(element.style.height).toBe('64px');
  });

  /* The stuck-open composer: before layout settles the field has no width, and
     `scrollHeight` counts every wrapped line, so measuring there clamps to the
     maximum and the field stays open until the next keystroke. */
  it('refuses to measure a field that has no width yet', () => {
    const element = field({ width: 0, value: 'Hey let us do a', scrollHeight: MAX_COMPOSER_TEXTAREA_PX });
    autogrowTextarea(element);
    expect(element.style.height).toBe('');
  });

  it('never exceeds the maximum, then scrolls instead', () => {
    const element = field({ width: 400, value: 'a\nb\nc\nd\ne\nf', scrollHeight: 900 });
    autogrowTextarea(element);
    expect(element.style.height).toBe(`${MAX_COMPOSER_TEXTAREA_PX}px`);
  });

  /* Empty hands the height back to CSS, so a composer that was tall a moment
     ago collapses to one line instead of leaving a void. */
  it('collapses an empty field back to its CSS min-height', () => {
    const element = field({ width: 400, value: '', scrollHeight: 400 });
    element.style.height = '220px';
    autogrowTextarea(element);
    expect(element.style.height).toBe('');
  });

  /* The send square's corner: one row keeps it centred, anything taller puts
     it on the bottom edge beside the last line. */
  it('reports a single row as not grown', () => {
    const element = field({ width: 400, value: 'One line', scrollHeight: 24, lineHeight: 24 });
    const seen: boolean[] = [];
    autogrowTextarea(element, null, (grown) => seen.push(grown));
    expect(seen).toEqual([false]);
  });

  it('reports more than one row as grown', () => {
    const element = field({ width: 400, value: 'Two\nlines', scrollHeight: 48, lineHeight: 24 });
    const seen: boolean[] = [];
    autogrowTextarea(element, null, (grown) => seen.push(grown));
    expect(seen).toEqual([true]);
  });

  it('does not call the listener when layout has not settled', () => {
    const element = field({ width: 0, value: 'Two\nlines', scrollHeight: 48 });
    const seen: boolean[] = [];
    autogrowTextarea(element, null, (grown) => seen.push(grown));
    expect(seen).toEqual([]);
  });
});

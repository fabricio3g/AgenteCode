import { describe, expect, it } from 'vitest';
import type { DesignComment, DesignSelection } from '$shared/design';
import { PICKER_SCRIPT, PICKER_SOURCE, decideTextEdit, formatTurnContext, pickLabel, readFrameMessage, withPicker } from './design-picker';

const pick: DesignSelection = {
  id: 'sel-1',
  page: 'index.html',
  selector: 'button.primary',
  tag: 'button',
  text: 'Get started',
  html: '<button class="primary">Get started</button>',
  box: { x: 32, y: 64, width: 120, height: 40 },
  styles: { color: 'rgb(255, 255, 255)', 'font-size': '14px' }
};

describe('withPicker', () => {
  it('injects one script before the last closing body tag', () => {
    const out = withPicker('<html><body><p>hi</p></body></html>');
    expect(out.indexOf(PICKER_SCRIPT)).toBeGreaterThan(out.indexOf('<p>hi</p>'));
    expect(out.indexOf('</body></html>')).toBeGreaterThan(out.indexOf(PICKER_SCRIPT));
    expect(out.split('<script>').length - 1).toBe(1);
  });

  it('appends when the page has no body', () => {
    expect(withPicker('<p>bare</p>').endsWith(PICKER_SCRIPT)).toBe(true);
  });
});

describe('PICKER_SOURCE', () => {
  it('parses as script and stays ES5 (no arrows, let, const or classes)', () => {
    expect(() => new Function(PICKER_SOURCE)).not.toThrow();
    expect(PICKER_SOURCE).not.toMatch(/=>|\blet\s|\bconst\s|\bclass\s|`/);
    expect(PICKER_SOURCE).not.toContain('</script');
  });
});

describe('readFrameMessage', () => {
  const element = { selector: pick.selector, tag: pick.tag, text: pick.text, html: pick.html, box: pick.box, styles: pick.styles };

  it('accepts a well-formed select and clamps oversized fields', () => {
    const message = readFrameMessage({ source: 'agente-design-frame', type: 'select', element: { ...element, text: 'x'.repeat(500) }, additive: true });
    expect(message).toMatchObject({ type: 'select', additive: true, element: { tag: 'button' } });
    if (message?.type === 'select') expect(message.element.text.length).toBe(140);
  });

  it('drops messages from other sources or with bad shapes', () => {
    expect(readFrameMessage({ source: 'other', type: 'escape' })).toBeNull();
    expect(readFrameMessage({ source: 'agente-design-frame', type: 'comment', selector: 'p', x: 'nope', y: 1 })).toBeNull();
    expect(readFrameMessage({ source: 'agente-design-frame', type: 'select', element: { selector: 'p' } })).toBeNull();
    expect(readFrameMessage(null)).toBeNull();
    expect(readFrameMessage({ source: 'agente-design-frame', type: 'unknown' })).toBeNull();
  });

  it('reads scroll, wheel and escape', () => {
    expect(readFrameMessage({ source: 'agente-design-frame', type: 'scroll', x: 0, y: 120 })).toEqual({ type: 'scroll', x: 0, y: 120 });
    expect(readFrameMessage({ source: 'agente-design-frame', type: 'wheel', deltaY: -40 })).toEqual({ type: 'wheel', deltaY: -40 });
    expect(readFrameMessage({ source: 'agente-design-frame', type: 'escape' })).toEqual({ type: 'escape' });
  });
});

describe('decideTextEdit', () => {
  const source = '<h1>Hello world</h1>\n<p>Hello again</p>';

  it('applies when the old text is unique in the source', () => {
    expect(decideTextEdit(source, ' Hello world ', 'Hi there')).toMatchObject({ kind: 'apply', oldText: 'Hello world', newText: 'Hi there' });
  });

  it('becomes a comment when the text is ambiguous or missing', () => {
    expect(decideTextEdit(source, 'Hello', 'Hey')).toMatchObject({ kind: 'comment', note: 'Change the text "Hello" to "Hey"' });
    expect(decideTextEdit(source, 'Missing', 'Hey').kind).toBe('comment');
    expect(decideTextEdit(undefined, 'Hello world', 'Hey').kind).toBe('comment');
  });

  it('does nothing when the text did not change', () => {
    expect(decideTextEdit(source, 'Hello world', ' Hello world ').kind).toBe('none');
  });
});

describe('formatTurnContext', () => {
  it('is empty when nothing was pointed at', () => {
    expect(formatTurnContext([], [])).toBe('');
  });

  it('names the page, the exact selector and the fenced html, then the comments', () => {
    const comment: DesignComment = { id: 'note-1', page: 'index.html', selector: '#hero', x: 10, y: 20, note: 'Make this bolder' };
    const text = formatTurnContext([pick], [comment]);
    expect(text).toContain('## The user pointed at these elements on index.html');
    expect(text).toContain('`button.primary`');
    expect(text).toContain('```html\n<button class="primary">Get started</button>\n```');
    expect(text).toContain('color: rgb(255, 255, 255)');
    expect(text).toContain('## Comments pinned on the canvas');
    expect(text).toContain('near `#hero`: Make this bolder');
    expect(text.indexOf('pointed')).toBeLessThan(text.indexOf('Comments pinned'));
  });

  it('widens the fence when the html already contains backticks', () => {
    const tricky = { ...pick, html: '<code>```</code>' };
    expect(formatTurnContext([tricky], [])).toContain('````html\n<code>```</code>\n````');
  });
});

describe('pickLabel', () => {
  it('shows the tag, first class and quoted text', () => {
    expect(pickLabel(pick)).toBe('button.primary "Get started"');
    expect(pickLabel({ tag: 'div', html: '<div>', text: '' })).toBe('div');
  });

  it('shortens long text', () => {
    expect(pickLabel({ tag: 'p', html: '<p>', text: 'a'.repeat(40) })).toBe(`p "${'a'.repeat(23)}…"`);
  });
});

describe('the timeline messages from the frame', () => {
  const item = { id: 'a0', selector: 'h1', tag: 'h1', name: 'rise', kind: 'animation', properties: ['opacity', 'transform'], delay: 0, duration: 400, iterations: 1, easing: 'cubic-bezier(0.2, 0, 0, 1)', playState: 'finished' };

  it('reads a list of live animations and the reduced-motion flag', () => {
    expect(readFrameMessage({ source: 'agente-design-frame', type: 'animations', items: [item, { ...item, id: 'a1', iterations: 'infinite' }], reduced: true }))
      .toEqual({ type: 'animations', items: [item, { ...item, id: 'a1', iterations: 'infinite' }], reduced: true });
  });

  it('drops a list with a malformed item, an unknown kind, or too many items', () => {
    expect(readFrameMessage({ source: 'agente-design-frame', type: 'animations', items: [{ ...item, kind: 'bash' }], reduced: false })).toBeNull();
    expect(readFrameMessage({ source: 'agente-design-frame', type: 'animations', items: [{ ...item, iterations: 'many' }], reduced: false })).toBeNull();
    expect(readFrameMessage({ source: 'agente-design-frame', type: 'animations', items: Array.from({ length: 41 }, () => item), reduced: false })).toBeNull();
    expect(readFrameMessage({ source: 'agente-design-frame', type: 'animations', items: 'nope', reduced: false })).toBeNull();
  });

  it('reads the playhead, and refuses a playhead without a playing flag', () => {
    expect(readFrameMessage({ source: 'agente-design-frame', type: 'animTick', time: 240.6, playing: true, count: 2 })).toEqual({ type: 'animTick', time: 240.6, playing: true, count: 2 });
    expect(readFrameMessage({ source: 'agente-design-frame', type: 'animTick', time: 10, playing: 'yes', count: 2 })).toBeNull();
    expect(readFrameMessage({ type: 'animTick', time: 10, playing: true, count: 2 })).toBeNull();
  });
});

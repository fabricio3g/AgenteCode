import { describe, expect, it } from 'vitest';
import { renderMarkdown, splitStreamingMarkdown } from './markdown';

describe('renderMarkdown', () => {
  it('renders paragraphs and inline code', () => {
    const html = renderMarkdown('Hello `world`');
    expect(html).toContain('<p>Hello <code>world</code></p>');
  });

  it('renders fenced code blocks', () => {
    const html = renderMarkdown('```js\nconst value = 1;\n```');
    expect(html).toContain('<pre>');
    expect(html).toContain('language-js');
    expect(html).toContain('hljs-keyword');
  });

  it('defers highlighting when asked, so streaming tails do not run hljs', () => {
    const html = renderMarkdown('```js\nconst value = 1;\n```', { highlight: false, cache: false });
    expect(html).toContain('data-lazy-highlight="true"');
    expect(html).not.toContain('hljs-keyword');
    expect(html).toContain('const value = 1;');
  });

  it('skips KaTeX when asked', () => {
    const withMath = renderMarkdown('$$x^2$$', { cache: false });
    const withoutMath = renderMarkdown('$$x^2$$', { math: false, cache: false });
    expect(withMath).toContain('katex');
    expect(withoutMath).not.toContain('katex');
  });
});

describe('splitStreamingMarkdown', () => {
  it('returns everything as tail when there is no block boundary yet', () => {
    expect(splitStreamingMarkdown('Half a sentence')).toEqual({
      settled: '',
      tail: 'Half a sentence'
    });
  });

  it('is empty for empty input', () => {
    expect(splitStreamingMarkdown('')).toEqual({ settled: '', tail: '' });
  });

  it('splits at the last blank line and loses no characters', () => {
    const source = 'First para.\n\nSecond para.\n\nThird par';
    const { settled, tail } = splitStreamingMarkdown(source);
    expect(settled).toBe('First para.\n\nSecond para.\n');
    expect(tail).toBe('Third par');
    // The join must reconstruct the input exactly, or content is dropped on screen.
    expect(settled + '\n' + tail).toBe(source);
  });

  it('keeps an unterminated fence whole in the tail', () => {
    const source = 'Intro text.\n\n```ts\nconst a = 1;\n\nconst b = 2;';
    const { settled, tail } = splitStreamingMarkdown(source);
    expect(settled).toBe('Intro text.\n');
    expect(tail).toBe('```ts\nconst a = 1;\n\nconst b = 2;');
  });

  it('never splits on a blank line inside a closed fence', () => {
    const source = '```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter';
    const { settled, tail } = splitStreamingMarkdown(source);
    expect(settled).toBe('```ts\nconst a = 1;\n\nconst b = 2;\n```\n');
    expect(tail).toBe('After');
  });

  it('splits before a list starts but never between its items', () => {
    // A blank line does not close a loose list, so splitting between `- one` and
    // `- two` would render two adjacent <ul>s. Splitting before `- one` is fine.
    const source = 'Steps:\n\n- one\n\n- two';
    const { settled, tail } = splitStreamingMarkdown(source);
    expect(settled).toBe('Steps:\n');
    expect(tail).toBe('- one\n\n- two');
  });

  it('treats an ordered list the same way', () => {
    const { settled, tail } = splitStreamingMarkdown('Intro:\n\n1. one\n\n2. two');
    expect(settled).toBe('Intro:\n');
    expect(tail).toBe('1. one\n\n2. two');
  });

  it('lets a list settle once a flush-left paragraph closes it', () => {
    const source = '- one\n- two\n\nAfter the list.\n\nNext par';
    const { settled, tail } = splitStreamingMarkdown(source);
    expect(settled).toBe('- one\n- two\n\nAfter the list.\n');
    expect(tail).toBe('Next par');
  });

  it('never splits inside an indented code block', () => {
    const source = 'Text\n\n    indented\n\n    more';
    expect(splitStreamingMarkdown(source)).toEqual({ settled: '', tail: source });
  });

  it('does split before blockquotes and table rows, which blank lines already close', () => {
    expect(splitStreamingMarkdown('Text\n\n> quoted').settled).toBe('Text\n');
    expect(splitStreamingMarkdown('Text\n\n| a | b |\n| - | - |').settled).toBe('Text\n');
  });

  it('does not split display math in half', () => {
    const source = 'Given:\n\n$$\na = b\n\nc = d\n$$';
    const { settled, tail } = splitStreamingMarkdown(source);
    expect(settled).toBe('Given:\n');
    expect(tail).toBe('$$\na = b\n\nc = d\n$$');
  });

  it('splits a heading away from the paragraph that follows it', () => {
    const { settled, tail } = splitStreamingMarkdown('# Title\n\nBody so');
    expect(settled).toBe('# Title\n');
    expect(tail).toBe('Body so');
  });

  // The whole design rests on this: a split must never change the rendered output,
  // or content visibly reflows the moment the message settles.
  it.each([
    ['paragraphs after a heading', '# Title\n\nFirst para.\n\nSecond para.'],
    ['prose then a list', 'Steps:\n\n- one\n- two'],
    ['prose then a loose list', 'Steps:\n\n- one\n\n- two'],
    ['a closed fence then prose', '```ts\nconst a = 1;\n```\n\nAfter.'],
    ['a list then prose then prose', '- one\n- two\n\nAfter the list.\n\nMore.'],
    ['a blockquote', 'Text\n\n> quoted'],
    ['a table', 'Text\n\n| a | b |\n| - | - |\n| 1 | 2 |']
  ])('renders identically split or whole: %s', (_label, source) => {
    const { settled, tail } = splitStreamingMarkdown(source);
    const joined = renderMarkdown(settled, { cache: false }) + renderMarkdown(tail, { cache: false });
    expect(joined).toBe(renderMarkdown(source, { cache: false }));
  });
});

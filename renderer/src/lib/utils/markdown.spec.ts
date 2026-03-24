import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

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
});

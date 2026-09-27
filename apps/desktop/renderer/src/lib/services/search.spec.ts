import { describe, expect, it } from 'vitest';
import { stripFrontmatter } from './search';

describe('stripFrontmatter', () => {
  it('drops leading YAML frontmatter', () => {
    const raw = '---\nlibrary_name: transformers\ntags:\n- gguf\n---\n\n# Title\n\nBody';
    expect(stripFrontmatter(raw)).toBe('# Title\n\nBody');
  });
  it('leaves plain markdown untouched', () => {
    expect(stripFrontmatter('# Hello')).toBe('# Hello');
    expect(stripFrontmatter('')).toBe('');
  });
});

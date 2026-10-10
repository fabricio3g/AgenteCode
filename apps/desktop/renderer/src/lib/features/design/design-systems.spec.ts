import { describe, expect, it } from 'vitest';
import { cleanSystemName, systemBriefing, systemSwatches } from './design-systems';

describe('cleanSystemName', () => {
  it('collapses spaces, trims and caps the length', () => {
    expect(cleanSystemName('  Studio   brand ')).toBe('Studio brand');
    expect(cleanSystemName('x'.repeat(90))).toHaveLength(60);
  });

  it('returns null when nothing is left', () => {
    expect(cleanSystemName('   \n\t ')).toBeNull();
  });
});

describe('systemSwatches', () => {
  it('lists light-scheme colours in declaration order, skipping other groups', () => {
    const css = ':root { --bg: #f7f6f3; --space: 16px; --accent: oklch(0.5 0.2 260); }\n@media (prefers-color-scheme: dark) { :root { --bg: #161614; } }';
    expect(systemSwatches(css)).toEqual(['#f7f6f3', 'oklch(0.5 0.2 260)']);
  });

  it('caps the row', () => {
    const css = `:root { ${Array.from({ length: 10 }, (_, i) => `--c${i}: #00000${i};`).join(' ')} }`;
    expect(systemSwatches(css, 3)).toHaveLength(3);
  });
});

describe('systemBriefing', () => {
  it('is empty when the design uses no system', () => {
    expect(systemBriefing(null)).toBe('');
  });

  it('carries the system guidance and tokens and tells the agent to obey them', () => {
    const text = systemBriefing({ name: 'Studio', designMd: '# Studio\n\nQuiet.', tokens: ':root { --bg: #fff; }' });
    expect(text).toContain('## Design system: Studio');
    expect(text).toContain('Quiet.');
    expect(text).toContain(':root { --bg: #fff; }');
    expect(text).toMatch(/never hard-code/);
  });

  it('caps very long guidance', () => {
    const text = systemBriefing({ name: 'Big', designMd: 'a'.repeat(9000), tokens: '' });
    expect(text).toContain('(truncated)');
    expect(text.length).toBeLessThan(7000);
  });
});

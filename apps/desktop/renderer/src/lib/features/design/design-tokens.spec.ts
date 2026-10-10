import { describe, expect, it } from 'vitest';
import { colorToHex, parseTokens, tokenEdit, tokenGroup, tokensFor } from './design-tokens';

const CSS = `/* tokens */
:root {
  --color-bg: #ffffff;
  --color-ink: oklch(0.2 0.02 260);
  --space-4: 16px;
  --radius-md: 10px;
  --font-body: "Inter", sans-serif;
  --shadow-card: 0 1px 2px rgb(0 0 0 / 0.1);
  --brand: rgb(230, 90, 40);
}
.card { --local: 1px; }
@media (prefers-color-scheme: dark) {
  :root {
    --color-bg: #111111;
    --color-ink: #f5f5f5;
  }
}
`;

describe('parseTokens', () => {
  const decls = parseTokens(CSS);

  it('reads custom properties on :root only, with their scheme and group', () => {
    expect(decls.find((d) => d.name === '--local')).toBeUndefined();
    const bg = decls.filter((d) => d.name === '--color-bg');
    expect(bg.map((d) => [d.scheme, d.value])).toEqual([['light', '#ffffff'], ['dark', '#111111']]);
    expect(decls.find((d) => d.name === '--space-4')?.group).toBe('space');
    expect(decls.find((d) => d.name === '--radius-md')?.group).toBe('radius');
    expect(decls.find((d) => d.name === '--font-body')?.group).toBe('font');
    expect(decls.find((d) => d.name === '--shadow-card')?.group).toBe('shadow');
    expect(decls.find((d) => d.name === '--brand')?.group).toBe('color');
  });

  it('keeps the last declaration of a name per scheme', () => {
    const light = tokensFor(decls, 'light');
    const dark = tokensFor(decls, 'dark');
    expect(light.find((d) => d.name === '--color-bg')?.value).toBe('#ffffff');
    expect(dark.map((d) => d.name)).toEqual(['--color-bg', '--color-ink']);
  });

  it('treats a dark :root selector as dark too', () => {
    const more = parseTokens(':root[data-theme="dark"] { --x: #000; }');
    expect(more[0].scheme).toBe('dark');
  });

  it('records offsets that point at the declaration', () => {
    for (const d of decls) {
      expect(CSS.slice(d.start, d.end).startsWith(d.name)).toBe(true);
      expect(CSS.slice(d.valueStart, d.end)).toBe(`${d.value};`);
    }
  });
});

describe('tokenEdit', () => {
  it('rewrites just the one declaration', () => {
    const decl = parseTokens(CSS).find((d) => d.name === '--space-4')!;
    const edit = tokenEdit(CSS, decl, '20px');
    expect(edit).toEqual({ old_text: '--space-4: 16px;', new_text: '--space-4: 20px;' });
    expect(CSS.replace(edit!.old_text, edit!.new_text)).toContain('--space-4: 20px;');
  });

  it('widens the edit when the declaration text is not unique', () => {
    const css = ':root {\n  --gap: 4px;\n}\n@media (prefers-color-scheme: dark) {\n  :root {\n    --gap: 4px;\n  }\n}\n';
    const dark = parseTokens(css).find((d) => d.scheme === 'dark')!;
    const edit = tokenEdit(css, dark, '8px')!;
    expect(css.split(edit.old_text).length - 1).toBe(1);
    const patched = css.replace(edit.old_text, edit.new_text);
    expect(patched.indexOf('--gap: 8px')).toBeGreaterThan(patched.indexOf('prefers-color-scheme'));
  });

  it('refuses values that could break out of the declaration', () => {
    const decl = parseTokens(CSS)[0];
    expect(tokenEdit(CSS, decl, 'red; } body { color: red')).toBeNull();
    expect(tokenEdit(CSS, decl, '   ')).toBeNull();
  });
});

describe('colorToHex', () => {
  it('converts the forms a colour input can show', () => {
    expect(colorToHex('#abc')).toBe('#aabbcc');
    expect(colorToHex('#A1B2C3')).toBe('#a1b2c3');
    expect(colorToHex('rgb(230, 90, 40)')).toBe('#e65a28');
    expect(colorToHex('rgba(0 0 0 / 1)')).toBe('#000000');
    expect(colorToHex('#11223380')).toBeNull();
  });

  it('returns null for values a colour input cannot hold', () => {
    expect(colorToHex('oklch(0.2 0.02 260)')).toBeNull();
    expect(colorToHex('var(--x)')).toBeNull();
    expect(colorToHex('rgba(0, 0, 0, 0.5)')).toBeNull();
  });
});

describe('tokenGroup', () => {
  it('prefers the name, then the value', () => {
    expect(tokenGroup('--surface', '#fff')).toBe('color');
    expect(tokenGroup('--thing', '12px')).toBe('other');
    expect(tokenGroup('--font-lg', '1.25rem')).toBe('font');
  });
});

describe('a declaration closed by its brace', () => {
  it('reads the last token of a block even without a semicolon', () => {
    const decls = parseTokens(':root{--duration-base:250ms;--ease-out:cubic-bezier(0.2,0,0,1)}');
    expect(decls.map((decl) => decl.name)).toEqual(['--duration-base', '--ease-out']);
    expect(decls.find((decl) => decl.name === '--ease-out')?.group).toBe('motion');
  });

  it('rewrites that declaration in place, with the semicolon the edit adds', () => {
    const css = ':root{--duration-base:250ms;--ease-out:cubic-bezier(0.2,0,0,1)}';
    const decl = parseTokens(css).find((item) => item.name === '--ease-out');
    expect(decl && tokenEdit(css, decl, 'linear(0, 1)')).toEqual({ old_text: '--ease-out:cubic-bezier(0.2,0,0,1)', new_text: '--ease-out:linear(0, 1);' });
  });
});


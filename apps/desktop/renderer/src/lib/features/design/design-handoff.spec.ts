import { describe, expect, it } from 'vitest';
import { ANY_STACK_PHRASE, buildHandoffPrompt, buildHandoffSpec, handoffTitle, stackPhrase } from './design-handoff';

const INDEX = `<!doctype html>
<html lang="en">
<head>
<meta name="viewport" content="width=device-width">
<title>Acme pricing</title>
<style>.hero:hover { color: red; } @media (max-width: 760px) { .hero { padding: 8px; } }</style>
</head>
<body>
<header class="bar"><nav class="bar"><a href="/">Home</a><a href="/x" aria-label="Close"></a></nav></header>
<img src="assets/logo.svg">
<img src="assets/hero.png" alt="Hero">
<button class="btn primary">Buy</button>
<button class="btn"><svg></svg></button>
<script>console.log(1)</script>
<script src="https://cdn.example.com/lib.js"></script>
</body>
</html>`;

const CSS = `:root { --color-bg: #fff; --color-ink: #111; --space-2: 8px; }
@media (prefers-color-scheme: dark) { :root { --color-bg: #000; --color-ink: #eee; } }
@keyframes fade-in { from { opacity: 0 } to { opacity: 1 } }
.btn { transition: background 120ms; outline: none; }
.btn:focus-visible { box-shadow: 0 0 0 2px red; }
@media (min-width: 1200px) { .hero { padding: 40px; } }`;

const FILES = {
  'index.html': INDEX,
  'tokens.css': CSS,
  'assets/logo.svg': '<svg></svg>',
  'DESIGN.md': '# Acme Pricing\n\nQuiet, confident, lots of air.'
};

describe('handoffTitle', () => {
  it('prefers the DESIGN.md heading, then the entry page title, then a default', () => {
    expect(handoffTitle(FILES, ['index.html'])).toBe('Acme Pricing');
    expect(handoffTitle({ 'index.html': INDEX }, ['index.html'])).toBe('Acme pricing');
    expect(handoffTitle({}, [])).toBe('Design');
  });
});

describe('stackPhrase', () => {
  it('uses the preset phrase, or the typed text when there is some', () => {
    expect(stackPhrase('svelte', '')).toBe('Svelte');
    expect(stackPhrase('html', '  ')).toMatch(/plain HTML and CSS/);
    expect(stackPhrase('react', 'Next.js + Tailwind')).toBe('Next.js + Tailwind');
    expect(stackPhrase('unknown', '')).toBe(ANY_STACK_PHRASE);
  });
});

describe('buildHandoffSpec', () => {
  const spec = buildHandoffSpec({ files: FILES, pages: ['index.html'], variants: [{ name: 'bold', entry: 'variants/bold/index.html' }] });

  it('lists the pages with the entry marked and variants after them', () => {
    expect(spec.startsWith('# Acme Pricing — handoff')).toBe(true);
    expect(spec).toContain('- `index.html` (entry) — "Acme pricing"');
    expect(spec).toContain('- `variants/bold/index.html` — variant "bold"');
  });

  it('tables the tokens for light and dark, pipes escaped', () => {
    expect(spec).toContain('| Token | Light | Dark |');
    expect(spec).toContain('| `--color-bg` | #fff | #000 |');
    expect(spec).toContain('| `--space-2` | 8px | — |');
  });

  it('finds shared classes, state styles, animations and scripts', () => {
    expect(spec).toContain('- `.btn` on 2 elements (button), in index.html');
    expect(spec).toContain('`:focus-visible`');
    expect(spec).toContain('`fade-in`');
    expect(spec).toContain('Inline script on index.html');
    expect(spec).toContain('External script on index.html: `https://cdn.example.com/lib.js`');
  });

  it('reports breakpoints and assets', () => {
    expect(spec).toContain('`@media (max-width: 760px)`');
    expect(spec).toContain('`@media (min-width: 1200px)`');
    expect(spec).toContain('- `assets/logo.svg`');
    expect(spec).not.toContain('- `assets/hero.png`');
  });

  it('flags accessibility gaps the static checks can see', () => {
    expect(spec).toContain('1 image without alt text');
    expect(spec).toContain('1 button without a name');
    expect(spec).toContain('Focus outlines removed in CSS (1)');
    expect(spec).toContain('Contrast is not measured here');
  });

  it('carries DESIGN.md as notes', () => {
    expect(spec).toContain('## Design notes');
    expect(spec).toContain('Quiet, confident, lots of air.');
  });

  it('is deterministic and handles an empty workspace', () => {
    expect(buildHandoffSpec({ files: FILES, pages: ['index.html'], variants: [] })).toBe(buildHandoffSpec({ files: FILES, pages: ['index.html'], variants: [] }));
    const empty = buildHandoffSpec({ files: {}, pages: [], variants: [] });
    expect(empty).toContain('No HTML pages yet.');
    expect(empty).toContain('No custom properties');
  });
});

describe('buildHandoffPrompt', () => {
  it('points at the copied folder and never pastes the document', () => {
    const prompt = buildHandoffPrompt({ title: 'Acme Pricing', folder: '.agente/designs/acme-pricing', stack: stackPhrase('react', '') });
    expect(prompt).toContain('"Acme Pricing" in this project with React with CSS modules.');
    expect(prompt).toContain('.agente/designs/acme-pricing/');
    expect(prompt).not.toContain('HANDOFF.md:\n\n');
  });

  it('pastes the document when there is no folder', () => {
    const prompt = buildHandoffPrompt({ title: 'Acme', folder: null, handoff: '# Acme — handoff' });
    expect(prompt).toContain('pasted below');
    expect(prompt).toContain('HANDOFF.md:\n\n# Acme — handoff');
    expect(prompt).toContain(`with ${ANY_STACK_PHRASE}`);
  });
});

describe('the Motion section', () => {
  const css = [
    ':root { --duration-base: 250ms; --ease-out: cubic-bezier(0.2, 0, 0, 1); --brand: #3b5bdb; }',
    '@media (prefers-reduced-motion: no-preference) {',
    '  .btn { transition: transform var(--duration-base) var(--ease-out); }',
    '  .card { animation: rise var(--duration-base) var(--ease-out) both; }',
    '  @keyframes rise { from { opacity: 0; } to { opacity: 1; } }',
    '}',
    '@media (prefers-reduced-motion: reduce) { .card { animation: none; } }'
  ].join('\n');

  it('lists the motion tokens, each animated rule, and the reduced-motion status', () => {
    const spec = buildHandoffSpec({ files: { 'tokens.css': css, 'index.html': '<!doctype html><title>Hi</title><main></main>' }, pages: ['index.html'], variants: [] });
    const section = spec.slice(spec.indexOf('## Motion'));
    expect(section).toContain('- `--duration-base`: 250ms');
    expect(section).toContain('- `--ease-out`: cubic-bezier(0.2, 0, 0, 1)');
    expect(section).toContain('- `.btn` under @media (prefers-reduced-motion: no-preference): transition: transform var(--duration-base) var(--ease-out)');
    expect(section).toContain('- `.card` under @media (prefers-reduced-motion: no-preference): animation: rise var(--duration-base) var(--ease-out) both');
    expect(section).toContain('- `.card` under @media (prefers-reduced-motion: reduce): animation: none');
    expect(section).toContain('- Keyframes: `rise`');
    expect(section).toContain('- Reduced motion: handled. 2 rules inside no-preference blocks; 1 rule inside reduce blocks.');
  });

  it('calls out rules that run for everyone', () => {
    const spec = buildHandoffSpec({ files: { 'tokens.css': css + '\n.hero { animation: pulse 2s infinite; }', 'index.html': '<main></main>' }, pages: ['index.html'], variants: [] });
    expect(spec).toContain('- Reduced motion: 1 rule outside any reduced-motion query, so it runs for everyone.');
    expect(spec).toContain('Put it in @media (prefers-reduced-motion: no-preference)');
  });

  it('says so when a design has no motion at all', () => {
    const spec = buildHandoffSpec({ files: { 'index.html': '<main></main>' }, pages: ['index.html'], variants: [] });
    expect(spec).toContain('No transitions or animations in the CSS.');
  });
});


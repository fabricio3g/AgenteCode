import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReferenceTokens, clampReferenceWidth, clusterColors, designMd, fontStack, nextReferenceName, parseColor,
  pickAccent, referenceBrief, referenceStem, spacingScale, tokensCss, toHex, typeScale
} from '../../main/design/reference-tokens.ts';

test('parseColor reads hex and rgb syntaxes and refuses what it cannot read', () => {
  assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor('#2563EB'), { r: 37, g: 99, b: 235, a: 1 });
  assert.equal(parseColor('#00000080').a, 128 / 255);
  assert.deepEqual(parseColor('rgb(17, 24, 39)'), { r: 17, g: 24, b: 39, a: 1 });
  assert.deepEqual(parseColor('rgba(0 0 0 / 50%)'), { r: 0, g: 0, b: 0, a: 0.5 });
  assert.equal(parseColor('currentcolor'), null);
  assert.equal(parseColor('oklch(0.6 0.2 260)'), null);
  assert.equal(toHex({ r: 37, g: 99, b: 235, a: 1 }), '#2563eb');
});

test('clusterColors merges near-identical shades and keeps the most used one', () => {
  const ranked = clusterColors([
    { color: '#111827', count: 40 },
    { color: '#121a2a', count: 9 },
    { color: '#ffffff', count: 30 },
    { color: 'rgba(0, 0, 0, 0.2)', count: 500 },
    { color: '#2563eb', count: 12 }
  ]);
  assert.deepEqual(ranked, [
    { value: '#111827', count: 49 },
    { value: '#ffffff', count: 30 },
    { value: '#2563eb', count: 12 }
  ]);
});

test('pickAccent prefers a saturated button colour and skips greys', () => {
  const colors = [
    { role: 'button', color: '#111111', count: 30 },
    { role: 'button', color: '#2563eb', count: 6 },
    { role: 'text', color: '#374151', count: 200 },
    { role: 'background', color: '#f0fdf4', count: 3 }
  ];
  assert.equal(pickAccent(colors), '#2563eb');
  assert.equal(pickAccent([{ role: 'text', color: '#111111', count: 9 }]), null);
});

test('spacingScale keeps the common values, merges neighbours and sorts ascending', () => {
  const scale = spacingScale([
    { value: 16, count: 90 }, { value: 15, count: 4 }, { value: 8, count: 50 }, { value: 24, count: 20 },
    { value: 0, count: 999 }, { value: 300, count: 40 }, { value: 4, count: 10 }
  ]);
  assert.deepEqual(scale, [4, 8, 16, 24]);
});

test('typeScale picks the most common style for each role and ignores roles the page never shows', () => {
  const scale = typeScale([
    { role: 'h1', size: 56, weight: 700, lineHeight: 61.6, family: '"Playfair Display", serif', count: 2 },
    { role: 'h1', size: 48, weight: 700, lineHeight: 52.8, family: 'Playfair Display', count: 5 },
    { role: 'p', size: 16, weight: 400, lineHeight: 25.6, family: 'Inter', count: 80 }
  ]);
  assert.deepEqual(scale.h1, { size: 48, weight: 700, lineHeight: 52.8, family: 'Playfair Display' });
  assert.deepEqual(scale.p, { size: 16, weight: 400, lineHeight: 25.6, family: 'Inter' });
  assert.equal(scale.h4, undefined);
});

test('fontStack quotes a family and adds a generic that matches it', () => {
  assert.equal(fontStack('Inter'), '"Inter", sans-serif');
  assert.equal(fontStack('Playfair Display'), '"Playfair Display", serif');
  assert.equal(fontStack('JetBrains Mono'), '"JetBrains Mono", monospace');
  assert.equal(fontStack('serif'), 'serif');
  assert.ok(!/[;{}]/.test(fontStack('x; } body { display: none')), 'declaration characters are stripped');
});

/** A small capture shaped like what the page script returns. */
function capture(overrides = {}) {
  return {
    url: 'https://example.com/landing',
    title: 'Example — Ship faster',
    width: 1440,
    height: 900,
    scrollHeight: 3000,
    sampled: 240,
    colors: [
      { role: 'text', color: '#111827', count: 180 },
      { role: 'text', color: '#6b7280', count: 60 },
      { role: 'background', color: '#ffffff', count: 120 },
      { role: 'background', color: '#e8e5df', count: 30 },
      { role: 'border', color: '#e5e7eb', count: 14 },
      { role: 'button', color: '#2563eb', count: 4 }
    ],
    fonts: [
      { role: 'text', family: 'Inter', count: 200 },
      { role: 'heading', family: 'Playfair Display', count: 12 }
    ],
    types: [
      { role: 'h1', size: 56, weight: 700, lineHeight: 61.6, family: 'Playfair Display', count: 1 },
      { role: 'p', size: 16, weight: 400, lineHeight: 25.6, family: 'Inter', count: 60 },
      { role: 'button', size: 15, weight: 600, lineHeight: 0, family: 'Inter', count: 3 }
    ],
    spacing: [{ value: 16, count: 80 }, { value: 8, count: 40 }, { value: 32, count: 12 }],
    radii: [{ value: '12px', count: 9 }, { value: '8px', count: 4 }, { value: '0px', count: 99 }],
    shadows: [{ value: 'rgba(0, 0, 0, 0.05) 0px 1px 2px 0px', count: 6 }],
    maxWidths: [{ value: 1200, count: 3 }],
    gridColumns: [{ value: 3, count: 2 }],
    sections: 4,
    hasNav: true,
    hasFooter: true,
    ...overrides
  };
}

test('buildReferenceTokens turns a capture into one palette, two fonts, a type scale and the layout', () => {
  const tokens = buildReferenceTokens(capture());
  assert.equal(tokens.palette.text, '#111827');
  assert.equal(tokens.palette.background, '#ffffff');
  assert.equal(tokens.palette.surface, '#e8e5df');
  assert.equal(tokens.palette.muted, '#6b7280');
  assert.equal(tokens.palette.border, '#e5e7eb');
  assert.equal(tokens.palette.accent, '#2563eb');
  assert.equal(tokens.fonts.body, 'Inter');
  assert.equal(tokens.fonts.heading, 'Playfair Display');
  assert.equal(tokens.type.h1.size, 56);
  assert.equal(tokens.type.button.weight, 600);
  assert.deepEqual(tokens.radii, ['8px', '12px']);
  assert.equal(tokens.contentWidth, 1200);
  assert.deepEqual(tokens.gridColumns, [3]);
});

test('surface and muted take a neutral shade, so an accent never stands in for them', () => {
  const tokens = buildReferenceTokens(capture({
    colors: [
      { role: 'text', color: '#111827', count: 50 },
      { role: 'text', color: '#2563eb', count: 20 },
      { role: 'text', color: '#6b7280', count: 10 },
      { role: 'background', color: '#ffffff', count: 100 },
      { role: 'background', color: '#2563eb', count: 9 },
      { role: 'background', color: '#e8e5df', count: 5 }
    ]
  }));
  assert.equal(tokens.palette.surface, '#e8e5df');
  assert.equal(tokens.palette.muted, '#6b7280');
  assert.equal(tokens.palette.accent, '#2563eb');
});

test('buildReferenceTokens falls back to plain defaults for an empty page', () => {
  const tokens = buildReferenceTokens(capture({ colors: [], fonts: [], types: [], spacing: [], radii: [], shadows: [], maxWidths: [], gridColumns: [] }));
  assert.equal(tokens.palette.text, '#111111');
  assert.equal(tokens.palette.background, '#ffffff');
  assert.equal(tokens.palette.accent, null);
  assert.equal(tokens.fonts.body, 'sans-serif');
  assert.equal(tokens.contentWidth, null);
});

test('tokensCss writes the semantic roles the design prompt names, and nothing from the page can end a declaration', () => {
  const css = tokensCss(buildReferenceTokens(capture({ url: 'https://evil.example/*/ } body{display:none}' })));
  assert.ok(css.startsWith('/* Extracted from https://evil.example/  bodydisplay:none by design_reference.'), css.split('\n')[0]);
  assert.equal((css.match(/\*\//g) || []).length, 1, 'the comment closes once');
  for (const token of ['--bg:', '--surface:', '--text:', '--muted:', '--accent: #2563eb', '--border: #e5e7eb', '--font-body: "Inter", sans-serif', '--font-heading: "Playfair Display", serif', '--size-h1: 56px', '--weight-h1: 700', '--leading-h1: 1.1', '--space-1: 8px', '--space-3: 32px', '--radius-sm: 8px', '--radius-md: 12px', '--shadow-sm: rgba(0, 0, 0, 0.05) 0px 1px 2px 0px', '--content-width: 1200px', '--grid-columns: 3']) {
    assert.ok(css.includes(token), `missing ${token}`);
  }
  const hostile = tokensCss(buildReferenceTokens(capture({ fonts: [{ role: 'text', family: 'Evil; } body { color: red', count: 9 }] })));
  assert.equal((hostile.match(/\{/g) || []).length, 1, 'only the :root block opens');
  assert.equal((hostile.match(/\}/g) || []).length, 1, 'only the :root block closes');
});

test('designMd names the source, the palette and the rules a system needs', () => {
  const md = designMd(buildReferenceTokens(capture()), new Date('2026-10-07T12:00:00Z'));
  assert.match(md, /^# Reference: Example — Ship faster/);
  assert.match(md, /Read from https:\/\/example\.com\/landing on 2026-10-07/);
  assert.match(md, /accent #2563eb → --accent/);
  assert.match(md, /## Typography/);
  assert.match(md, /## Rules/);
});

test('referenceBrief is one compact reading the model can use, with the notes it needs', () => {
  const tokens = buildReferenceTokens(capture());
  const brief = referenceBrief(tokens, { image: 'attached (1440px wide viewport)', saved: 'references/example-com-1.png', system: 'Example landing' });
  assert.ok(brief.length < 1500, `brief is ${brief.length} characters`);
  assert.match(brief, /^Reference: https:\/\/example\.com\/landing/);
  assert.match(brief, /accent #2563eb/);
  assert.match(brief, /h1 56px\/700\/1\.1/);
  assert.match(brief, /Spacing \(px\): 8, 16, 32\./);
  assert.match(brief, /Screenshot: attached/);
  assert.match(brief, /Saved: references\/example-com-1\.png/);
  assert.match(brief, /saved as "Example landing"/);
  assert.match(brief, /not the logo, copy or imagery/);
});

test('referenceStem and nextReferenceName number screenshots per host', () => {
  assert.equal(referenceStem('https://www.Stripe.com/payments'), 'stripe-com');
  assert.equal(referenceStem('not a url'), 'page');
  assert.equal(nextReferenceName('stripe-com', []), 'stripe-com-1.png');
  assert.equal(nextReferenceName('stripe-com', ['stripe-com-1.png', 'stripe-com-3.png', 'hero.png']), 'stripe-com-4.png');
  assert.equal(nextReferenceName('stripe-com', ['vercel-com-9.png']), 'stripe-com-1.png');
});

test('clampReferenceWidth keeps the viewport in range and defaults to desktop', () => {
  assert.equal(clampReferenceWidth(undefined), 1440);
  assert.equal(clampReferenceWidth(Number.NaN), 1440);
  assert.equal(clampReferenceWidth(390), 390);
  assert.equal(clampReferenceWidth(10), 320);
  assert.equal(clampReferenceWidth(99999), 2560);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { REFERENCE_PAGE_SCRIPT, REFERENCE_SETTLE_SCRIPT } from '../../main/design/reference-page.ts';
import { buildReferenceTokens } from '../../main/design/reference-tokens.ts';

/**
 * The reader runs in a real page; here a small linkedom document stands in,
 * with computed styles and boxes supplied by hand. The script itself is the
 * exact source the window receives (REFERENCE_PAGE_SCRIPT), not a copy.
 */
const FIXTURE = `<!doctype html><html><head><title>Example Landing</title></head><body>
  <nav>Menu</nav>
  <main>
    <h1>Ship faster</h1>
    <p>Ship the thing with confidence.</p>
    <button>Start</button>
    <section id="s1"><div id="c1">One</div><div>Two</div><div>Three</div></section>
  </main>
  <footer>Footer</footer>
</body></html>`;

const BASE = {
  display: 'block', visibility: 'visible', color: 'rgb(17, 24, 39)', backgroundColor: 'rgba(0, 0, 0, 0)',
  fontFamily: 'Inter, sans-serif', fontSize: '16px', fontWeight: '400', lineHeight: 'normal',
  borderTopWidth: '0px', borderTopStyle: 'none', borderTopColor: 'rgb(0, 0, 0)', borderTopLeftRadius: '0px',
  boxShadow: 'none', maxWidth: 'none', gridTemplateColumns: 'none',
  marginTop: '0px', marginRight: '0px', marginBottom: '0px', marginLeft: '0px',
  paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px', rowGap: 'normal', columnGap: 'normal'
};
const BY_TAG = {
  html: { backgroundColor: 'rgb(255, 255, 255)' },
  body: { backgroundColor: 'rgb(255, 255, 255)' },
  h1: { fontFamily: '"Playfair Display", serif', fontSize: '56px', fontWeight: '700', lineHeight: '61.6px' },
  p: { color: 'rgb(107, 114, 128)', fontSize: '16px', lineHeight: '25.6px', marginBottom: '16px' },
  button: { backgroundColor: 'rgb(37, 99, 235)', color: 'rgb(255, 255, 255)', borderTopLeftRadius: '8px', fontSize: '15px', fontWeight: '600' },
  nav: { paddingTop: '8px' },
  main: { maxWidth: '1200px', paddingTop: '32px' }
};
const BY_ID = {
  s1: { display: 'grid', gridTemplateColumns: '368px 368px 368px', columnGap: '32px' },
  c1: { backgroundColor: 'rgb(232, 229, 223)', borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: 'rgb(229, 231, 235)', borderTopLeftRadius: '12px', boxShadow: 'rgba(0, 0, 0, 0.05) 0px 1px 2px 0px', paddingTop: '24px' }
};

function readPage(html = FIXTURE) {
  const { document } = parseHTML(html);
  const main = document.querySelector('main');
  if (main) main.getBoundingClientRect = () => ({ x: 0, y: 0, width: 1200, height: 800 });
  const computed = (el) => {
    const inline = el.getAttribute('style') || '';
    const hidden = /display:\s*none/.test(inline) ? { display: 'none' } : {};
    return { ...BASE, ...(BY_TAG[el.tagName.toLowerCase()] ?? {}), ...(BY_ID[el.id] ?? {}), ...hidden };
  };
  const run = new Function('document', 'getComputedStyle', 'location', 'window', `return ${REFERENCE_PAGE_SCRIPT};`);
  return run(document, computed, { href: 'https://example.com/landing' }, { innerWidth: 1440, innerHeight: 900 });
}

const count = (rows, match) => rows.filter(match).reduce((sum, row) => sum + row.count, 0);

test('the page reader tallies colours, fonts and type from the page, not from a guess', () => {
  const reading = readPage();
  assert.equal(reading.url, 'https://example.com/landing');
  assert.equal(reading.title, 'Example Landing');
  assert.equal(reading.width, 1440);
  assert.equal(reading.sampled, 12);
  assert.equal(count(reading.colors, (row) => row.role === 'text' && row.color === '#111827'), 6);
  assert.equal(count(reading.colors, (row) => row.role === 'text' && row.color === '#6b7280'), 1);
  assert.equal(count(reading.colors, (row) => row.role === 'background' && row.color === '#ffffff'), 120, 'the body and html weigh the most');
  assert.equal(count(reading.colors, (row) => row.role === 'button' && row.color === '#2563eb'), 1);
  assert.equal(count(reading.colors, (row) => row.role === 'border' && row.color === '#e5e7eb'), 1);
  assert.deepEqual(reading.fonts.find((row) => row.role === 'heading'), { role: 'heading', family: 'Playfair Display', count: 1 });
  assert.deepEqual(reading.types.find((row) => row.role === 'h1'), { role: 'h1', size: 56, weight: 700, lineHeight: 61.6, family: 'Playfair Display', count: 1 });
  assert.deepEqual(reading.types.find((row) => row.role === 'button'), { role: 'button', size: 15, weight: 600, lineHeight: 0, family: 'Inter', count: 1 });
});

test('the page reader finds the spacing, radii, shadows and layout a reference needs', () => {
  const reading = readPage();
  assert.equal(reading.spacing.find((row) => row.value === 32).count, 2, 'main padding and the grid gap');
  assert.equal(reading.spacing.find((row) => row.value === 16).count, 1);
  assert.deepEqual(reading.radii.map((row) => row.value).sort(), ['12px', '8px']);
  assert.equal(reading.shadows.length, 1);
  assert.deepEqual(reading.maxWidths, [{ value: 1200, count: 1 }]);
  assert.deepEqual(reading.gridColumns, [{ value: 3, count: 1 }]);
  assert.equal(reading.sections, 1);
  assert.equal(reading.hasNav, true);
  assert.equal(reading.hasFooter, true);
});

test('the reader output feeds the token builder into a usable reading', () => {
  const tokens = buildReferenceTokens(readPage());
  assert.equal(tokens.palette.text, '#111827');
  assert.equal(tokens.palette.background, '#ffffff');
  assert.equal(tokens.palette.surface, '#e8e5df');
  assert.equal(tokens.palette.accent, '#2563eb');
  assert.equal(tokens.fonts.heading, 'Playfair Display');
  assert.equal(tokens.fonts.body, 'Inter');
  assert.equal(tokens.type.h1.size, 56);
  assert.equal(tokens.contentWidth, 1200);
  assert.deepEqual(tokens.gridColumns, [3]);
});

test('the reader skips elements that are not displayed, text and all', () => {
  const hidden = readPage('<html><body><p style="display:none">Gone</p><p>Shown</p></body></html>');
  assert.equal(hidden.sampled, 3, 'html, body and the one visible paragraph');
  assert.equal(count(hidden.colors, (row) => row.role === 'text'), 1);
});

test('the settle script waits for fonts with a bound, so a slow font cannot hang a read', () => {
  assert.match(REFERENCE_SETTLE_SCRIPT, /document\.fonts\.ready/);
  assert.match(REFERENCE_SETTLE_SCRIPT, /setTimeout\(done, 1500\)/);
});

// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderAsync } from 'docx-preview';
import { countRenderedPages, fitZoom } from './docx-pages';

/**
 * The two seams the DOCX viewer depends on from the page renderer:
 *
 * 1. `fitZoom` clamps to (0, 1] — pages are scaled down to the reader column
 *    but never up, so a small document stays its true size.
 * 2. `renderAsync` fills the container with real `<section class="docx">`
 *    pages (not one flow div) and `countRenderedPages` reads them back. If a
 *    library update changes either, the viewer silently regresses to the
 *    endless text column it was built to replace.
 *
 * The fixture is a small real DOCX (tables, headings) committed with the
 * spec so this test is independent of any dependency's test data.
 */

describe('fitZoom', () => {
  it('scales a wide page down to the available width', () => {
    expect(fitZoom(800, 400)).toBe(0.5);
  });

  it('never scales a page up past its own size', () => {
    expect(fitZoom(400, 800)).toBe(1);
  });

  it('falls back to 1 for unusable measurements', () => {
    expect(fitZoom(0, 800)).toBe(1);
    expect(fitZoom(800, 0)).toBe(1);
    expect(fitZoom(Number.NaN, 400)).toBe(1);
  });
});

describe('docx-preview pagination', () => {
  it('renders a real document into countable section pages', async () => {
    const docx = readFileSync(join(__dirname, '__fixtures__/tables.docx'));
    const body = document.createElement('div');
    await renderAsync(docx, body, body, { breakPages: true, ignoreLastRenderedPageBreak: false });

    expect(countRenderedPages(body)).toBeGreaterThan(0);
    // The wrapper every page lives in is what the viewer restyles.
    expect(body.querySelector('.docx-wrapper')).not.toBeNull();
  }, 30_000);
});

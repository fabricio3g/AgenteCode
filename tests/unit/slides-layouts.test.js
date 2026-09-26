import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { generatePptx } from '../../main/slides.ts';

async function slideXml(bytes) {
  const zip = await JSZip.loadAsync(Buffer.from(bytes));
  const names = Object.keys(zip.files);
  const slides = names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  return { names, slides: await Promise.all(slides.map((name) => zip.file(name).async('string'))) };
}

describe('generatePptx layouts', () => {
  it('draws each layout: native chart, hairline table, left-aligned text, notes', async () => {
    const bytes = await generatePptx({
      title: 'Kickoff',
      theme: 'dark',
      slides: [
        { title: 'Kickoff', subtitle: 'Q4' },
        { title: 'Goals', bullets: ['Win two retainers', 'Ship Aurora'], notes: 'Lead with retainers.' },
        { title: 'Budget', chart: { type: 'line', labels: ['Oct', 'Nov'], series: [{ name: 'Revenue', values: [1, 2] }] } },
        { title: 'Projects', table: { columns: ['Client', 'Due'], rows: [['Aurora', 'Nov 28']] } }
      ]
    });
    const { names, slides } = await slideXml(bytes);
    assert.equal(slides.length, 4);
    assert.ok(names.some((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name)), 'native chart part');
    assert.match(slides[3], /<a:tbl>/);
    assert.match(slides[1], /algn="l"/);
    assert.match(slides[0], /161618/i, 'dark background');
    assert.ok(names.some((name) => /notesSlide\d+\.xml$/.test(name)), 'speaker notes');
    assert.doesNotMatch(slides.join(''), /Chatea/);
  });
});

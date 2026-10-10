// PPTX slide generation
// Uses pptxgenjs which is a pure JS library

import { ARTIFACT_ACCENTS, ARTIFACT_BRAND, ARTIFACT_INK, bareHex } from '../shared/artifact-theme.ts';
import { normalizeDeck, type DeckSpec } from '../shared/deck.ts';

const W = 13.333;
const H = 7.5;
const MARGIN = 0.75;
const FONT = 'Inter';
const FONT_DISPLAY = 'Inter';

/**
 * A deck (see shared/deck.ts) as a real .pptx: one quiet design — neutral
 * ink, one muted accent, generous margins — with a layout per slide: title,
 * section, bullets, two columns, quote, big numbers, a table or a native
 * PowerPoint chart. Older callers that pass { title, slides: [{ title,
 * content }] } still work; the normalizer infers the layouts.
 */
export async function generatePptx(data) {
  const PptxGenJS = (await import('pptxgenjs')).default;
  const deck: DeckSpec = normalizeDeck(data || {});
  const ink = ARTIFACT_INK[deck.theme];
  const accent = bareHex(ARTIFACT_ACCENTS[deck.accent][deck.theme]);
  const text = bareHex(ink.text);
  const muted = bareHex(ink.muted);
  const line = bareHex(ink.line);
  const soft = bareHex(ink.soft);
  const bg = bareHex(ink.bg);
  // Series colors: the accent first, then the other muted accents.
  const palette = [deck.accent, ...Object.keys(ARTIFACT_ACCENTS).filter((key) => key !== deck.accent && key !== 'slate'), 'slate']
    .map((key) => bareHex(ARTIFACT_ACCENTS[key as keyof typeof ARTIFACT_ACCENTS][deck.theme]));

  const pptx = new PptxGenJS();
  pptx.title = deck.title;
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = ARTIFACT_BRAND;
  pptx.subject = deck.subtitle || deck.title;
  pptx.theme = { headFontFace: FONT_DISPLAY, bodyFontFace: FONT, lang: 'en-US' };

  const total = deck.slides.length;
  deck.slides.forEach((slide, index) => {
    const s = pptx.addSlide();
    s.background = { color: bg };

    const heading = (value: string, y = 0.62, size = 28) => {
      if (!value) return;
      s.addText(value, { x: MARGIN, y, w: W - MARGIN * 2, h: 0.9, fontFace: FONT_DISPLAY, fontSize: size, bold: true, color: text, valign: 'top', fit: 'shrink', margin: 0, align: 'left' });
    };
    const bulletList = (items: string[], x: number, y: number, w: number, h: number, size = 20) => {
      if (!items.length) return;
      s.addText(items.map((item) => ({ text: item, options: { bullet: { indent: 18 }, breakLine: true } })), {
        x, y, w, h, fontFace: FONT, fontSize: size, color: text, valign: 'top', fit: 'shrink', paraSpaceAfter: 10, lineSpacingMultiple: 1.1, margin: 0, align: 'left'
      });
    };
    const footer = () => {
      if (slide.layout === 'title') return;
      s.addText(`${index + 1} / ${total}`, { x: W - MARGIN - 1.5, y: H - 0.55, w: 1.5, h: 0.3, fontFace: FONT, fontSize: 10, color: muted, align: 'right', margin: 0 });
    };

    switch (slide.layout) {
      case 'title': {
        s.addShape(pptx.ShapeType.rect, { x: MARGIN, y: 2.55, w: 0.6, h: 0.07, fill: { color: accent }, line: { color: accent } });
        s.addText(slide.title || deck.title, { x: MARGIN, y: 2.8, w: W - MARGIN * 2, h: 1.6, fontFace: FONT_DISPLAY, fontSize: 44, bold: true, color: text, valign: 'top', fit: 'shrink', margin: 0, align: 'left' });
        const sub = slide.subtitle || deck.subtitle;
        if (sub) s.addText(sub, { x: MARGIN, y: 4.45, w: W - MARGIN * 2, h: 0.9, fontFace: FONT, fontSize: 20, color: muted, valign: 'top', margin: 0, align: 'left' });
        s.addText(ARTIFACT_BRAND, { x: MARGIN, y: H - 0.75, w: 4, h: 0.3, fontFace: FONT, fontSize: 11, color: muted, margin: 0, align: 'left' });
        break;
      }
      case 'section': {
        s.background = { color: soft };
        s.addShape(pptx.ShapeType.rect, { x: MARGIN, y: 3.05, w: 0.6, h: 0.07, fill: { color: accent }, line: { color: accent } });
        s.addText(slide.title, { x: MARGIN, y: 3.3, w: W - MARGIN * 2, h: 1.2, fontFace: FONT_DISPLAY, fontSize: 36, bold: true, color: text, valign: 'top', fit: 'shrink', margin: 0, align: 'left' });
        if (slide.subtitle) s.addText(slide.subtitle, { x: MARGIN, y: 4.5, w: W - MARGIN * 2, h: 0.7, fontFace: FONT, fontSize: 18, color: muted, margin: 0, align: 'left' });
        break;
      }
      case 'two-column': {
        heading(slide.title);
        const colW = (W - MARGIN * 2 - 0.6) / 2;
        [slide.left, slide.right].forEach((col, i) => {
          if (!col) return;
          const x = MARGIN + i * (colW + 0.6);
          let y = 1.75;
          if (col.heading) {
            s.addText(col.heading, { x, y, w: colW, h: 0.5, fontFace: FONT, fontSize: 18, bold: true, color: accent, margin: 0, align: 'left' });
            y += 0.65;
          }
          bulletList(col.bullets, x, y, colW, H - y - 0.9, 18);
        });
        break;
      }
      case 'quote': {
        s.addText('“', { x: MARGIN - 0.1, y: 1.3, w: 1.2, h: 1.2, fontFace: 'Georgia', fontSize: 96, color: accent, margin: 0, align: 'left' });
        s.addText(slide.quote || slide.title, { x: MARGIN + 0.2, y: 2.35, w: W - MARGIN * 2 - 0.4, h: 2.6, fontFace: FONT_DISPLAY, fontSize: 32, italic: true, color: text, valign: 'top', fit: 'shrink', margin: 0, align: 'left' });
        if (slide.attribution) s.addText(`— ${slide.attribution}`, { x: MARGIN + 0.2, y: 5.15, w: W - MARGIN * 2, h: 0.5, fontFace: FONT, fontSize: 16, color: muted, margin: 0, align: 'left' });
        break;
      }
      case 'stats': {
        heading(slide.title);
        const items = slide.stats ?? [];
        const gap = 0.35;
        const cardW = (W - MARGIN * 2 - gap * (items.length - 1)) / Math.max(1, items.length);
        items.forEach((stat, i) => {
          const x = MARGIN + i * (cardW + gap);
          s.addShape(pptx.ShapeType.roundRect, { x, y: 2.1, w: cardW, h: 2.6, fill: { color: soft }, line: { color: soft }, rectRadius: 0.12 });
          s.addText(stat.value, { x: x + 0.3, y: 2.45, w: cardW - 0.6, h: 1.2, fontFace: FONT_DISPLAY, fontSize: 44, bold: true, color: accent, fit: 'shrink', margin: 0, align: 'left' });
          s.addText(stat.label, { x: x + 0.3, y: 3.7, w: cardW - 0.6, h: 0.8, fontFace: FONT, fontSize: 16, color: muted, valign: 'top', margin: 0, align: 'left' });
        });
        bulletList(slide.bullets, MARGIN, 5.1, W - MARGIN * 2, 1.4, 16);
        break;
      }
      case 'table': {
        heading(slide.title);
        const t = slide.table!;
        // Hairlines under each row only, like a well-set report table.
        const none = { type: 'none' };
        const rows = [
          t.columns.map((col) => ({ text: col, options: { bold: true, color: muted, fontSize: 14, border: [none, none, { type: 'solid', pt: 1.25, color: text }, none] } })),
          ...t.rows.map((row) => t.columns.map((_, c) => ({ text: row[c] ?? '', options: { color: text, fontSize: 16, border: [none, none, { type: 'solid', pt: 0.75, color: line }, none] } })))
        ];
        s.addTable(rows as never, {
          x: MARGIN, y: 1.8, w: W - MARGIN * 2, fontFace: FONT, fontSize: 16, align: 'left', valign: 'middle',
          rowH: Array(rows.length).fill(0.55), margin: [0.06, 0.12, 0.06, 0.12], border: none, autoPage: false
        } as never);
        break;
      }
      case 'chart': {
        heading(slide.title);
        const c = slide.chart!;
        const type = c.type === 'line' ? pptx.ChartType.line : c.type === 'pie' ? pptx.ChartType.pie : c.type === 'doughnut' ? pptx.ChartType.doughnut : pptx.ChartType.bar;
        const round = c.type === 'pie' || c.type === 'doughnut';
        s.addChart(type, c.series.map((series) => ({ name: series.name, labels: c.labels, values: series.values })), {
          x: MARGIN, y: 1.6, w: W - MARGIN * 2, h: H - 2.5,
          barDir: c.type === 'bar' ? 'bar' : 'col',
          chartColors: round ? palette.slice(0, c.labels.length) : palette.slice(0, c.series.length),
          showLegend: c.series.length > 1 || round,
          legendPos: 'b',
          legendFontSize: 12,
          legendColor: muted,
          catAxisLabelColor: muted,
          valAxisLabelColor: muted,
          catAxisLabelFontSize: 12,
          valAxisLabelFontSize: 12,
          valGridLine: { color: line, size: 0.5 },
          catGridLine: { style: 'none' },
          catAxisLineShow: false,
          valAxisLineShow: false,
          lineSize: 3,
          lineDataSymbol: 'none',
          holeSize: 60,
          showPercent: round,
          dataLabelColor: text
        } as never);
        break;
      }
      default: {
        heading(slide.title);
        bulletList(slide.bullets, MARGIN, 1.75, W - MARGIN * 2, H - 2.6);
      }
    }

    footer();
    if (slide.notes) s.addNotes(slide.notes);
  });

  const buffer = await pptx.write({ outputType: 'nodebuffer' });
  return Array.from(new Uint8Array(buffer as ArrayBuffer));
}

export async function parseSlidesFromMarkdown(markdown) {
  const slides = [];
  const sections = markdown.split(/^---+$/m).filter(s => s.trim());

  for (const section of sections) {
    const lines = section.trim().split('\n');
    let title = '';
    const content = [];
    let notes = null;
    let layout = 'default';
    let inNotes = false;

    for (const line of lines) {
      if (line.match(/^#+\s/)) {
        title = line.replace(/^#+\s*/, '').trim();
      } else if (line.match(/^<!--\s*notes:/i)) {
        inNotes = true;
        notes = '';
      } else if (inNotes && line.includes('-->')) {
        inNotes = false;
      } else if (inNotes) {
        notes += line + '\n';
      } else {
        content.push(line);
      }
    }

    slides.push({
      title: title || content[0]?.replace(/^[#\-*]\s*/, '') || 'Slide',
      content: content.filter(Boolean),
      notes: notes?.trim() || null,
      layout
    });
  }

  return slides.length ? slides : [{
    title: 'Untitled Slide',
    content: [markdown.trim()],
    notes: null,
    layout: 'default'
  }];
}

export async function slidesToMarkdown(slides) {
  return slides.map(slide => {
    let md = `## ${slide.title}\n\n`;
    md += (slide.content || []).join('\n') + '\n';
    if (slide.notes) {
      md += `\n<!-- notes: ${slide.notes} -->\n`;
    }
    return md;
  }).join('\n---\n\n');
}

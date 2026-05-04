// PPTX slide generation
// Uses pptxgenjs which is a pure JS library

export async function generatePptx(data) {
  const PptxGenJS = (await import('pptxgenjs')).default;
  const pptx = new PptxGenJS();

  pptx.title = data.title || 'Presentation';
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'Chatea LM';
  pptx.subject = data.subtitle || 'Generated work product';
  pptx.theme = {
    headFontFace: 'Aptos Display',
    bodyFontFace: 'Aptos',
    lang: 'en-US'
  };

  const slides = data.slides || [];
  for (const [index, slide] of slides.entries()) {
    const s = pptx.addSlide();
    s.background = { color: index === 0 ? 'F8FAFC' : 'FFFFFF' };
    s.addShape(pptx.ShapeType.rect, {
      x: 0, y: 0, w: 13.333, h: 0.08,
      fill: { color: '2563EB' },
      line: { color: '2563EB' }
    });

    if (slide.title) {
      s.addText(slide.title, {
        x: 0.65, y: 0.45, w: 11.7, h: 0.75,
        fontFace: 'Aptos Display',
        fontSize: index === 0 ? 34 : 26,
        bold: true,
        color: '0F172A',
        breakLine: false,
        fit: 'shrink'
      });
    }

    const content = (slide.content || []).map(item => String(item || '').replace(/^[-*]\s*/, '').trim()).filter(Boolean);
    if (content.length) {
      s.addText(content.map(text => ({ text, options: { bullet: { type: 'ul' }, breakLine: true } })), {
        x: 0.8, y: index === 0 ? 1.65 : 1.45, w: 11.6, h: 4.75,
        fontFace: 'Aptos',
        fontSize: index === 0 ? 18 : 16,
        color: '334155',
        valign: 'top',
        fit: 'shrink',
        paraSpaceAfterPt: 8
      });
    }

    s.addText(`Chatea LM · ${index + 1}`, {
      x: 0.65, y: 6.95, w: 2.5, h: 0.2,
      fontSize: 8,
      color: '94A3B8'
    });

    if (slide.notes) {
      s.addNotes(slide.notes);
    }
  }

  const buffer = await pptx.write({ outputType: 'nodebuffer' });
  return Array.from(new Uint8Array(buffer));
}

export async function savePptx(data, outputPath) {
  const fs = await import('node:fs');
  const bytes = await generatePptx(data);
  fs.writeFileSync(outputPath, Buffer.from(bytes));
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

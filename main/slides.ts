// PPTX slide generation
// Uses pptxgenjs which is a pure JS library

export async function generatePptx(data) {
  const PptxGenJS = (await import('pptxgenjs')).default;
  const pptx = new PptxGenJS();

  pptx.title = data.title || 'Presentation';

  for (const slide of data.slides || []) {
    const s = pptx.addSlide();

    if (slide.title) {
      s.addText(slide.title, {
        x: 0.5, y: 0.3, w: '90%', h: 0.8,
        fontSize: 28, bold: true, color: '333333'
      });
    }

    const content = (slide.content || []).join('\n');
    if (content) {
      s.addText(content, {
        x: 0.5, y: 1.3, w: '90%', h: '60%',
        fontSize: 16, color: '555555', valign: 'top'
      });
    }

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

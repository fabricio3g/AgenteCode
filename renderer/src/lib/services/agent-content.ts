export function buildPreviewHtml(files: Record<string, string>, entry = 'index.html'): string | null {
  const html = files[entry] || files['index.html'] || files['index.htm'];
  if (!html) {
    const js = Object.entries(files).filter(([file]) => file.endsWith('.js') && !file.startsWith('__'));
    const css = Object.entries(files).filter(([file]) => file.endsWith('.css') && !file.startsWith('__'));
    if (!js.length && !css.length) return null;
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
${css.map(([file, content]) => `<style>/* ${file} */\n${content}</style>`).join('\n')}
</head><body>
${js.map(([file, content]) => `<script>/* ${file} */\n${content}</script>`).join('\n')}
</body></html>`;
  }
  let result = html;
  for (const [file, content] of Object.entries(files)) {
    if (file.startsWith('__')) continue;
    const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (file.endsWith('.css')) {
      result = result.replace(
        new RegExp(`<link[^>]+href=["']${escaped}["'][^>]*/?>`, 'i'),
        `<style>/* ${file} */\n${content}</style>`
      );
    } else if (file.endsWith('.js')) {
      result = result.replace(
        new RegExp(`<script[^>]+src=["']${escaped}["'][^>]*>\\s*</script>`, 'i'),
        `<script>/* ${file} */\n${content}</script>`
      );
    }
  }
  return result;
}

export function buildHtmlReport(
  title: string,
  sections: Array<{ title?: string; heading?: string; content?: string }>,
  options: { theme?: 'light' | 'dark' } = {}
): string {
  const theme = options.theme || 'light';
  const dark = theme === 'dark';
  const sectionHtml = sections.map((section) => `
    <section>
      <h2>${section.title || section.heading || 'Section'}</h2>
      <p>${String(section.content || '').replace(/\n/g, '<br/>')}</p>
    </section>
  `).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8" />
<title>${title}</title>
<style>
body{font-family:Inter,system-ui,Segoe UI,Arial,sans-serif;max-width:880px;margin:32px auto;padding:0 16px;line-height:1.55;color:${dark ? '#f4f4f5' : '#111827'};background:${dark ? '#0b1020' : '#ffffff'};}
h1{font-size:2rem;margin:0 0 1rem 0}
h2{font-size:1.2rem;margin:1.2rem 0 .4rem}
section{border:1px solid ${dark ? '#334155' : '#e5e7eb'};border-radius:10px;padding:12px 14px;margin:10px 0;background:${dark ? '#111827' : '#fafafa'};}
a{color:${dark ? '#93c5fd' : '#1d4ed8'}}
</style></head><body>
<h1>${title}</h1>
${sectionHtml}
</body></html>`;
}

export function buildMarkdownReport(
  title: string,
  sections: Array<{ title?: string; heading?: string; content?: string }>
): string {
  const body = sections
    .map((section) => `## ${section.title || section.heading || 'Section'}\n\n${String(section.content || '').trim()}`)
    .join('\n\n');
  return `# ${title}\n\n${body}`.trim() + '\n';
}

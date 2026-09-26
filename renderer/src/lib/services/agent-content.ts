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

export function buildMarkdownReport(
  title: string,
  sections: Array<{ title?: string; heading?: string; content?: string }>
): string {
  const body = sections
    .map((section) => `## ${section.title || section.heading || 'Section'}\n\n${String(section.content || '').trim()}`)
    .join('\n\n');
  return `# ${title}\n\n${body}`.trim() + '\n';
}

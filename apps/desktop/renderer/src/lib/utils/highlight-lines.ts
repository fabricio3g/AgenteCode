// The common set (~37 languages: rust, ts, python, go, bash, json, yaml, sql…)
// instead of all ~190: a fraction of the bundle, and highlightAuto only has
// to try these.
import hljs from 'highlight.js/lib/common';

/** Grammars for extensions highlight.js has no alias for. */
const EXTENSION_LANGUAGE: Record<string, string> = {
  svelte: 'xml',
  vue: 'xml',
  mjs: 'javascript',
  cjs: 'javascript',
  mts: 'typescript',
  cts: 'typescript',
  jsonc: 'json',
  toml: 'ini'
};

/** The highlight.js grammar for a file path, or undefined when there is none. */
export function languageForPath(path: string): string | undefined {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile') return 'makefile';
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  const language = EXTENSION_LANGUAGE[ext] ?? ext;
  return language && hljs.getLanguage(language) ? language : undefined;
}

/**
 * Highlights `lines` as one text, so comments and strings that span lines
 * stay correct, and returns one HTML string per line. A span still open at a
 * line break is closed there and reopened on the next line.
 */
export function highlightLines(lines: string[], language: string): string[] {
  const html = hljs.highlight(lines.join('\n'), { language, ignoreIllegals: true }).value;
  const out: string[] = [];
  const open: string[] = [];
  let current = '';
  for (const part of html.split(/(<span[^>]*>|<\/span>|\n)/)) {
    if (!part) continue;
    if (part === '\n') {
      out.push(current + '</span>'.repeat(open.length));
      current = open.join('');
    } else {
      if (part.startsWith('<span')) open.push(part);
      else if (part === '</span>') open.pop();
      current += part;
    }
  }
  out.push(current);
  return out;
}

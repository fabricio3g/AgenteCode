/**
 * Pure helpers for handoff: the HANDOFF.md a developer reads, and the prompt
 * that turns the design into code in a project. Everything is read from the
 * workspace's files, so the same input always gives the same document.
 */
import type { DesignVariant } from '$shared/design';
import { parseTokens, tokensFor } from './design-tokens';

const NOTES_MAX = 4000;
const IMAGE_FILE = /\.(png|jpe?g|webp|gif|avif|svg)$/i;
const LANDMARKS = ['header', 'nav', 'main', 'footer', 'aside', 'section', 'article', 'form', 'dialog', 'table', 'details', 'button', 'input', 'select', 'textarea', 'a', 'img', 'svg', 'video', 'audio', 'canvas', 'iframe'];

/** Build targets the dialog offers. `label` is the product name; the plain-HTML option is labelled in copy. */
export const STACK_PRESETS: { id: string; phrase: string; label?: string }[] = [
  { id: 'html', phrase: 'plain HTML and CSS, built as designed' },
  { id: 'react', label: 'React + CSS modules', phrase: 'React with CSS modules' },
  { id: 'svelte', label: 'Svelte', phrase: 'Svelte' },
  { id: 'vue', label: 'Vue', phrase: 'Vue' },
  { id: 'tailwind', label: 'Tailwind', phrase: 'Tailwind CSS' }
];
/** The phrase used when the user picked nothing: whatever the project already uses. */
export const ANY_STACK_PHRASE = 'the stack this project already uses, or plain HTML and CSS if it has none';

/** The stack phrase for a preset chip, or for free text typed instead (kept as typed, capped). */
export function stackPhrase(presetId: string, typed: string): string {
  const custom = typed.trim().slice(0, 80);
  if (custom) return custom;
  return STACK_PRESETS.find((preset) => preset.id === presetId)?.phrase ?? ANY_STACK_PHRASE;
}

export interface HandoffInput {
  /** Text files verbatim, images as data URLs (see `collectFiles`). */
  files: Record<string, string>;
  /** Top-level HTML pages, entry first. */
  pages: string[];
  variants: DesignVariant[];
}

const htmlFiles = (files: Record<string, string>) => Object.keys(files).filter((file) => /\.html?$/i.test(file)).sort();
const cssText = (files: Record<string, string>) => Object.keys(files).filter((file) => /\.css$/i.test(file)).map((file) => files[file]).join('\n');
/** The markup and the `<style>` blocks inside it, the places a page declares rules. */
const styleText = (html: string) => [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((match) => match[1]).join('\n');
const unique = <T,>(items: Iterable<T>) => [...new Set(items)];
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** The design's title: the first heading of DESIGN.md, else the entry page's `<title>`. */
export function handoffTitle(files: Record<string, string>, pages: string[]): string {
  const heading = files['DESIGN.md']?.match(/^#\s+(.+?)\s*$/m)?.[1];
  if (heading) return heading.slice(0, 120);
  const entry = pages[0] ? files[pages[0]] : undefined;
  const title = entry?.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim();
  return title ? title.slice(0, 120) : 'Design';
}

/** Table cells: one line, pipes escaped. */
const cell = (value: string | undefined) => (value === undefined ? '—' : value.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim() || '—');

function tokenTable(css: string): string[] {
  const decls = parseTokens(css);
  const light = tokensFor(decls, 'light');
  const dark = tokensFor(decls, 'dark');
  if (!light.length && !dark.length) return [];
  const lightValue = new Map(light.map((decl) => [decl.name, decl.value]));
  const darkValue = new Map(dark.map((decl) => [decl.name, decl.value]));
  const names = unique([...light, ...dark].map((decl) => decl.name));
  return [
    '| Token | Light | Dark |',
    '| --- | --- | --- |',
    ...names.map((name) => `| \`${name}\` | ${cell(lightValue.get(name))} | ${cell(darkValue.get(name))} |`)
  ];
}

/** Classes used by more than one element, with the tags and pages they sit on. */
function componentLines(files: Record<string, string>, pages: string[]): string[] {
  const uses = new Map<string, { count: number; tags: Set<string>; pages: Set<string> }>();
  for (const page of pages) {
    for (const match of files[page].matchAll(/<([a-zA-Z][\w-]*)\b[^>]*?\sclass\s*=\s*(["'])([^"']*)\2/g)) {
      for (const name of match[3].split(/\s+/).filter(Boolean)) {
        const entry = uses.get(name) ?? { count: 0, tags: new Set<string>(), pages: new Set<string>() };
        entry.count += 1;
        entry.tags.add(match[1].toLowerCase());
        entry.pages.add(page);
        uses.set(name, entry);
      }
    }
  }
  return [...uses.entries()]
    .filter(([, entry]) => entry.count >= 2)
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, 24)
    .map(([name, entry]) => `- \`.${name}\` on ${entry.count} elements (${[...entry.tags].join(', ')}), in ${[...entry.pages].join(', ')}`);
}

function landmarkLines(files: Record<string, string>, pages: string[]): string[] {
  const parts = LANDMARKS.map((tag) => {
    const count = pages.reduce((sum, page) => sum + (files[page].match(new RegExp(`<${tag}[\\s>/]`, 'gi'))?.length ?? 0), 0);
    return count ? `${count} ${tag}` : '';
  }).filter(Boolean);
  return parts.length ? [`- ${parts.join(', ')}`] : [];
}

function interactionLines(files: Record<string, string>, pages: string[]): string[] {
  const css = `${cssText(files)}\n${pages.map((page) => styleText(files[page])).join('\n')}`;
  const lines: string[] = [];
  const states = unique([...css.matchAll(/:(hover|focus-visible|focus-within|focus|active|checked|disabled|invalid|open)\b/g)].map((match) => `:${match[1]}`)).sort();
  if (states.length) lines.push(`- State styles: ${states.map((state) => `\`${state}\``).join(', ')}`);
  const frames = unique([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((match) => match[1])).sort();
  if (frames.length) lines.push(`- Animations: ${frames.map((name) => `\`${name}\``).join(', ')}`);
  const transitions = (css.match(/\btransition(?:-property)?\s*:/g) ?? []).length;
  if (transitions) lines.push(`- Transitions: ${plural(transitions, 'declaration')}`);
  for (const page of pages) {
    for (const match of files[page].matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const src = match[1].match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
      if (src) lines.push(`- External script on ${page}: \`${src}\``);
      else if (match[2].trim()) lines.push(`- Inline script on ${page} (${match[2].trim().length} characters): behaviour to port by hand`);
    }
  }
  return lines.length ? lines : ['- None. The pages are static, with no scripts, state styles or animations.'];
}

function responsiveLines(files: Record<string, string>): string[] {
  const text = Object.keys(files).filter((file) => /\.(css|html?)$/i.test(file)).map((file) => files[file]).join('\n');
  const queries = unique([...text.matchAll(/@media\s*([^{]+)\{/gi)].map((match) => match[1].replace(/\s+/g, ' ').trim())).slice(0, 16);
  return queries.length
    ? queries.map((query) => `- \`@media ${query}\``)
    : ['- No media queries: the layout does not adapt. Check it at 390px wide before building.'];
}

function assetLines(files: Record<string, string>): string[] {
  const assets = Object.keys(files).filter((file) => file.startsWith('assets/') || IMAGE_FILE.test(file)).sort();
  return assets.length ? assets.map((file) => `- \`${file}\``) : ['- None.'];
}

function accessibilityLines(files: Record<string, string>, pages: string[]): string[] {
  const lines: string[] = [];
  for (const page of htmlFiles(files)) {
    const html = files[page];
    const found: string[] = [];
    const images = html.match(/<img\b(?![^>]*\balt\s*=)[^>]*>/gi)?.length ?? 0;
    if (images) found.push(plural(images, 'image without alt text', 'images without alt text'));
    const unnamed = (tag: 'button' | 'a') => [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'gi'))]
      .filter(([, attrs, inner]) => !inner.replace(/<[^>]*>/g, '').trim() && !/\b(aria-label|title)\s*=/i.test(attrs)).length;
    const buttons = unnamed('button');
    if (buttons) found.push(plural(buttons, 'button without a name', 'buttons without a name'));
    const links = unnamed('a');
    if (links) found.push(plural(links, 'link without a name', 'links without a name'));
    if (/<html\b/i.test(html) && !/<html\b[^>]*\blang\s*=/i.test(html)) found.push('no lang on <html>');
    if (/<html\b|<head\b/i.test(html) && !/<title\b/i.test(html)) found.push('no <title>');
    if (/<html\b/i.test(html) && !/<meta[^>]+name\s*=\s*["']viewport["']/i.test(html)) found.push('no viewport meta');
    if (found.length) lines.push(`- \`${page}\`: ${found.join('; ')}`);
  }
  const outlines = cssText(files).match(/outline\s*:\s*(none|0)\b/gi)?.length ?? 0;
  if (outlines) lines.push(`- Focus outlines removed in CSS (${outlines}): restore a visible focus style`);
  if (!lines.length) lines.push(`- No problems found by the static checks on ${pages.length ? pages.join(', ') : 'the pages'}.`);
  lines.push('- Contrast is not measured here: check body text against its background (WCAG AA is 4.5:1).');
  return lines;
}

/** Every stylesheet and <style> block of the design, as one text. */
const allCss = (files: Record<string, string>) => [cssText(files), ...htmlFiles(files).map((file) => styleText(files[file]))].join('\n');

interface CssLeaf { selector: string; body: string; media: string[] }

/** Every rule that holds declarations (not a group such as @media), with the @media queries it sits inside. */
function leafRules(css: string): CssLeaf[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const stack: Array<{ prelude: string; from: number; nested: boolean }> = [];
  const out: CssLeaf[] = [];
  let last = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '{') {
      const parent = stack[stack.length - 1];
      if (parent) parent.nested = true;
      const head = text.slice(last, index);
      stack.push({ prelude: head.slice(head.lastIndexOf(';') + 1).trim(), from: index + 1, nested: false });
      last = index + 1;
    } else if (char === '}') {
      const frame = stack.pop();
      if (frame && !frame.nested) out.push({ selector: frame.prelude, body: text.slice(frame.from, index), media: stack.map((open) => open.prelude).filter((prelude) => prelude.startsWith('@media')) });
      last = index + 1;
    }
  }
  return out;
}

/** The transition and animation declarations of a rule body, as written. */
function motionDecls(body: string): string[] {
  return body.split(';').map((decl) => decl.trim()).filter((decl) => /^(transition|animation)(-[a-z-]+)?\s*:/i.test(decl));
}

const KEYFRAME_STOP = /^(from|to|\d+(\.\d+)?%)(\s*,\s*(from|to|\d+(\.\d+)?%))*$/;

/**
 * The Motion section: the motion tokens, every rule that transitions or
 * animates, and whether those rules respect the user's reduced-motion setting.
 * Read from the CSS, not rendered, so it says what the code asks for.
 */
function motionLines(files: Record<string, string>): string[] {
  const css = allCss(files);
  const tokens = tokensFor(parseTokens(css), 'light').filter((decl) => decl.group === 'motion');
  const tokenLines = tokens.length
    ? tokens.map((decl) => `- \`${decl.name}\`: ${decl.value}`)
    : ['- No motion tokens yet (--duration-* and --ease-*): animations use literal values.'];
  const animated = leafRules(css)
    .filter((rule) => !rule.selector.startsWith('@') && !KEYFRAME_STOP.test(rule.selector))
    .map((rule) => ({ rule, decls: motionDecls(rule.body) }))
    .filter((item) => item.decls.length > 0);
  const keyframes = unique([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((match) => match[1]));
  if (!animated.length && !keyframes.length) return [...tokenLines, '- No transitions or animations in the CSS.'];
  const reducedQuery = (media: string[], wanted: 'reduce' | 'no-preference') => media.find((query) => new RegExp(`prefers-reduced-motion:\\s*${wanted}`, 'i').test(query));
  let gated = 0;
  let reduce = 0;
  let open = 0;
  for (const { rule } of animated) {
    if (reducedQuery(rule.media, 'no-preference')) gated += 1;
    else if (reducedQuery(rule.media, 'reduce')) reduce += 1;
    else open += 1;
  }
  const rules = animated.map(({ rule, decls }) => {
    const query = rule.media.find((item) => /prefers-reduced-motion/i.test(item));
    return `- \`${rule.selector}\`${query ? ` under @media ${query.replace(/^@media\s*/, '')}` : ''}: ${decls.join('; ')}`;
  });
  const status = open === 0
    ? `- Reduced motion: handled. ${plural(gated, 'rule')} inside no-preference blocks; ${plural(reduce, 'rule')} inside reduce blocks.`
    : `- Reduced motion: ${plural(open, 'rule')} outside any reduced-motion query, so it runs for everyone. Put it in @media (prefers-reduced-motion: no-preference), or switch it off in a reduce block.`;
  return [
    '**Tokens**',
    ...tokenLines,
    '',
    '**Animations**',
    ...(rules.length ? rules : ['- None outside keyframes.']),
    ...(keyframes.length ? [`- Keyframes: ${keyframes.map((name) => `\`${name}\``).join(', ')}`] : []),
    '',
    status
  ];
}

/** HANDOFF.md: what the design is made of and how it behaves, read from the files. */
export function buildHandoffSpec({ files, pages, variants }: HandoffInput): string {
  const title = handoffTitle(files, pages);
  const css = cssText(files);
  const pageList = pages.map((page) => {
    const name = files[page]?.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim();
    return `- \`${page}\`${page === pages[0] ? ' (entry)' : ''}${name ? ` — "${name}"` : ''}`;
  });
  for (const variant of variants) pageList.push(`- \`${variant.entry}\` — variant "${variant.name}"`);
  const pageHtml = pages.length ? pages : htmlFiles(files);
  const or = (lines: string[], fallback: string) => (lines.length ? lines : [fallback]);
  const sections: [string, string[]][] = [
    ['Pages', or(pageList, '- No HTML pages yet.')],
    ['Tokens', or(tokenTable(css), 'No custom properties on `:root` in the CSS files. Values are written in place.')],
    ['Components', or(componentLines(files, pageHtml), 'No class is shared by two or more elements.')],
    ['Controls and landmarks', or(landmarkLines(files, pageHtml), '- None.')],
    ['Interactions', interactionLines(files, pageHtml)],
    ['Motion', motionLines(files)],
    ['Responsive', responsiveLines(files)],
    ['Assets', assetLines(files)],
    ['Accessibility', accessibilityLines(files, pageHtml)]
  ];
  const notes = files['DESIGN.md']?.trim();
  const body = sections.map(([heading, lines]) => `## ${heading}\n\n${lines.join('\n')}`);
  if (notes) {
    const clipped = notes.length > NOTES_MAX ? `${notes.slice(0, NOTES_MAX)}\n\n…(truncated)` : notes;
    body.push(`## Design notes\n\nFrom \`DESIGN.md\`:\n\n${clipped}`);
  }
  return [
    `# ${title} — handoff`,
    'This is a design, not a build: plain HTML and CSS with no framework. Open `index.html` in a browser to see it. Everything here was read from the files; nothing was rendered.',
    ...body
  ].join('\n\n') + '\n';
}

export interface HandoffPromptOptions {
  title: string;
  /** Workspace-relative folder the design was copied to; null when the design is pasted in. */
  folder: string | null;
  /** A phrase from `stackPhrase`; defaults to whatever the project uses. */
  stack?: string;
  /** HANDOFF.md, pasted in when the design has no folder in the project. */
  handoff?: string;
}

/** The first message of a Code conversation that builds the handed-off design. */
export function buildHandoffPrompt({ title, folder, stack = ANY_STACK_PHRASE, handoff }: HandoffPromptOptions): string {
  const source = folder
    ? `The design is in ${folder}/: index.html is the entry, tokens.css holds the tokens, DESIGN.md the designer's notes, and HANDOFF.md lists its pages, tokens, states and accessibility notes.`
    : 'The design is pasted below (its HANDOFF.md). Its source files are not in this project.';
  const rules = [
    'Follow this project\'s conventions: its components, styling approach, file layout and naming.',
    'Map the design\'s tokens onto the project\'s own theme or variables. Do not hard-code values the tokens name.',
    'Match the layout, copy, spacing and states in the pages and HANDOFF.md, including the listed interactions.',
    'Fix the accessibility notes while you build.',
    'Build only the screens the design shows. Ask before adding others.',
    'Check the result in the running app at 390px, 834px and 1440px, and list anything you could not match.'
  ];
  return [
    `Build the design "${title}" in this project with ${stack}.`,
    source,
    rules.map((rule) => `- ${rule}`).join('\n'),
    handoff ? `HANDOFF.md:\n\n${handoff}` : ''
  ].filter(Boolean).join('\n\n');
}

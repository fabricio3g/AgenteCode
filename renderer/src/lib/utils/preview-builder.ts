import type { AgentArtifact } from '$lib/types/chat';
import { artifactPreviewCsp } from '$shared/artifact-preview-policy';

const TEXT_ASSET_EXTENSIONS = new Set(['html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'json', 'svg', 'txt', 'md', 'xml', 'webmanifest']);
const MIME_BY_EXT: Record<string, string> = {
  html: 'text/html;charset=utf-8',
  htm: 'text/html;charset=utf-8',
  css: 'text/css;charset=utf-8',
  js: 'text/javascript;charset=utf-8',
  mjs: 'text/javascript;charset=utf-8',
  cjs: 'text/javascript;charset=utf-8',
  ts: 'text/plain;charset=utf-8',
  jsx: 'text/plain;charset=utf-8',
  tsx: 'text/plain;charset=utf-8',
  json: 'application/json;charset=utf-8',
  svg: 'image/svg+xml;charset=utf-8',
  txt: 'text/plain;charset=utf-8',
  md: 'text/markdown;charset=utf-8',
  xml: 'application/xml;charset=utf-8',
  webmanifest: 'application/manifest+json;charset=utf-8'
};

function normalizePath(path: string): string {
  const normalized: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      normalized.pop();
      continue;
    }
    normalized.push(part);
  }
  return normalized.join('/');
}

function dirname(path: string): string {
  const parts = normalizePath(path).split('/');
  parts.pop();
  return parts.join('/');
}

function isExternalResource(ref: string): boolean {
  return /^(?:[a-z][a-z\d+.-]*:)?\/\//i.test(ref) || /^[a-z][a-z\d+.-]*:/i.test(ref);
}

function isBlockedLocalResource(ref: string): boolean {
  return /^(?:blob|file|filesystem):/i.test(ref.trim());
}

function resolveArtifactPath(basePath: string, ref: string): string | null {
  const cleaned = ref.trim().split(/[?#]/)[0] || '';
  if (!cleaned || cleaned.startsWith('#') || cleaned.startsWith('data:') || isBlockedLocalResource(cleaned) || isExternalResource(cleaned)) return null;
  if (cleaned.startsWith('/')) return normalizePath(cleaned.slice(1));
  const baseDir = dirname(basePath);
  return normalizePath(baseDir ? `${baseDir}/${cleaned}` : cleaned);
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function buildAssetDataUrl(path: string, content: string): string | null {
  if (content.startsWith('data:')) return content;
  const ext = path.split('.').pop()?.toLowerCase() || '';
  if (!TEXT_ASSET_EXTENSIONS.has(ext)) return null;
  const mime = MIME_BY_EXT[ext];
  if (!mime) return null;
  return `data:${mime};base64,${encodeBase64(content)}`;
}

function recordExternalRef(externalRefs: string[], ref: string) {
  if (!externalRefs.includes(ref)) externalRefs.push(ref);
}

function rewriteCssAssetUrls(css: string, cssPath: string, allFiles: Record<string, string>, externalRefs: string[]): string {
  return css.replace(/url\(([^)]+)\)/g, (match, rawValue: string) => {
    const ref = rawValue.trim().replace(/^['"]|['"]$/g, '');
    if (!ref || ref.startsWith('#') || ref.startsWith('data:')) return match;
    if (isBlockedLocalResource(ref)) return 'url("")';
    if (isExternalResource(ref)) {
      recordExternalRef(externalRefs, ref);
      return 'url("")';
    }
    const resolved = resolveArtifactPath(cssPath, ref);
    const content = resolved ? allFiles[resolved] : null;
    const dataUrl = resolved && content ? buildAssetDataUrl(resolved, content) : null;
    return dataUrl ? `url("${dataUrl}")` : match;
  });
}

export function buildPreviewHtml(
  htmlSource: string,
  allFiles: Record<string, string>,
  basePath: string,
  interactive = false
): { html: string; externalRefs: string[] } {
  const externalRefs: string[] = [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlSource, 'text/html');

  // Static embedded previews must not navigate their own frame or create other
  // browsing contexts. Interactive execution is reserved for the native guest.
  doc.querySelectorAll('base, meta[http-equiv], iframe, frame, frameset, object, embed').forEach((node) => node.remove());
  // SVG animation can mutate link destinations even when JavaScript is disabled.
  if (!interactive) doc.querySelectorAll('animate, set, animateMotion, animateTransform').forEach((node) => node.remove());
  doc.querySelectorAll('a, area').forEach((anchor) => {
    for (const attr of ['href', 'xlink:href']) {
      const ref = anchor.getAttribute(attr);
      if (ref && !ref.startsWith('#')) anchor.removeAttribute(attr);
    }
    anchor.removeAttribute('ping');
    anchor.removeAttribute('target');
  });

  doc.querySelectorAll('link[href]').forEach((link) => {
    const href = link.getAttribute('href');
    if (!href) return;
    if (isBlockedLocalResource(href)) {
      link.remove();
      return;
    }
    if (isExternalResource(href)) {
      recordExternalRef(externalRefs, href);
      link.remove();
      return;
    }
    const resolved = resolveArtifactPath(basePath, href);
    if (resolved && allFiles[resolved] && (((link.getAttribute('rel') || '').includes('stylesheet')) || resolved.endsWith('.css'))) {
      const style = doc.createElement('style');
      style.textContent = `/* ${resolved} */\n${rewriteCssAssetUrls(allFiles[resolved], resolved, allFiles, externalRefs)}`;
      link.replaceWith(style);
      return;
    }
    const dataUrl = resolved && allFiles[resolved] ? buildAssetDataUrl(resolved, allFiles[resolved]) : null;
    if (dataUrl) link.setAttribute('href', dataUrl);
  });

  doc.querySelectorAll('style').forEach((styleEl) => {
    styleEl.textContent = rewriteCssAssetUrls(styleEl.textContent || '', basePath, allFiles, externalRefs);
  });

  doc.querySelectorAll('script[src]').forEach((scriptEl) => {
    const script = scriptEl as HTMLScriptElement;
    const src = script.getAttribute('src');
    if (!src) return;
    if (isBlockedLocalResource(src)) {
      script.remove();
      return;
    }
    if (isExternalResource(src)) {
      recordExternalRef(externalRefs, src);
      script.remove();
      return;
    }
    const resolved = resolveArtifactPath(basePath, src);
    if (resolved && allFiles[resolved]) {
      const inline = doc.createElement('script');
      if (script.type) inline.type = script.type;
      if (script.noModule) inline.noModule = true;
      if (script.hasAttribute('defer')) inline.setAttribute('defer', '');
      if (script.hasAttribute('async')) inline.setAttribute('async', '');
      inline.textContent = `/* ${resolved} */\n${allFiles[resolved]}`;
      script.replaceWith(inline);
    } else {
      script.remove();
    }
  });

  doc.querySelectorAll('link[href]').forEach((linkEl) => {
    const href = linkEl.getAttribute('href');
    if (!href) return;
    if (href.startsWith('data:')) return;
    if (isBlockedLocalResource(href)) {
      linkEl.remove();
      return;
    }
    if (isExternalResource(href)) return;
    const resolved = resolveArtifactPath(basePath, href);
    if (!resolved || !allFiles[resolved]) {
      linkEl.remove();
    }
  });

  const assetTargets: Array<[string, string]> = [
    ['img[src]', 'src'],
    ['source[src]', 'src'],
    ['audio[src]', 'src'],
    ['video[poster]', 'poster'],
    ['link[rel="icon"][href]', 'href']
  ];

  for (const [selector, attribute] of assetTargets) {
    doc.querySelectorAll(selector).forEach((element) => {
      const ref = element.getAttribute(attribute);
      if (!ref || ref.startsWith('data:') || ref.startsWith('#')) return;
      if (isBlockedLocalResource(ref)) {
        element.removeAttribute(attribute);
        return;
      }
      if (isExternalResource(ref)) {
        recordExternalRef(externalRefs, ref);
        element.removeAttribute(attribute);
        return;
      }
      const resolved = resolveArtifactPath(basePath, ref);
      const content = resolved ? allFiles[resolved] : null;
      const dataUrl = resolved && content ? buildAssetDataUrl(resolved, content) : null;
      if (dataUrl) element.setAttribute(attribute, dataUrl);
    });
  }

  doc.querySelectorAll('a[href]').forEach((anchor) => {
    const href = anchor.getAttribute('href');
    if (href && isBlockedLocalResource(href)) {
      anchor.removeAttribute('href');
    }
  });

  let head = doc.querySelector('head');
  if (!head) {
    head = doc.createElement('head');
    const htmlEl = doc.querySelector('html') || doc.documentElement;
    htmlEl.insertBefore(head, htmlEl.firstChild);
  }

  if (!doc.querySelector('meta[charset]')) {
    const charset = doc.createElement('meta');
    charset.setAttribute('charset', 'utf-8');
    head.insertBefore(charset, head.firstChild);
  }

  if (!doc.querySelector('meta[name="viewport"]')) {
    const viewport = doc.createElement('meta');
    viewport.setAttribute('name', 'viewport');
    viewport.setAttribute('content', 'width=device-width, initial-scale=1');
    head.appendChild(viewport);
  }

  const policy = doc.createElement('meta');
  policy.setAttribute('http-equiv', 'Content-Security-Policy');
  policy.setAttribute('content', artifactPreviewCsp(interactive));
  head.insertBefore(policy, head.firstChild);
  const referrer = doc.createElement('meta');
  referrer.setAttribute('name', 'referrer');
  referrer.setAttribute('content', 'no-referrer');
  head.insertBefore(referrer, policy.nextSibling);

  return { html: '<!DOCTYPE html>' + doc.documentElement.outerHTML, externalRefs };
}

export function isSimpleArtifact(artifact: AgentArtifact | null): boolean {
  if (!artifact) return false;
  const visibleFiles = Object.entries(artifact.files).filter(([k]) => !k.startsWith('__'));
  if (visibleFiles.length > 3) return false;
  const totalSize = visibleFiles.reduce((sum, [, c]) => sum + c.length, 0);
  return totalSize <= 8192;
}

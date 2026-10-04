import type { Renderer } from 'marked';

/** Presentation only: references never become invented file-opening actions. */
export function referenceKind(text: string): 'file' | 'folder' | undefined {
  if (/\s|[<>()=]|^https?:\/\//i.test(text)) return undefined;
  const path = text.replace(/:\d+(?::\d+)?$/, '');
  const hasPath = /^(?:~[/\\]|\.{0,2}[/\\]|[a-z]:[/\\]|[\w.@-]+[/\\])\S+$/i.test(path);
  const hasExtension = /^[\w.@-]+\.(?:rs|[cm]?[jt]sx?|svelte|vue|py|go|md|json|toml|ya?ml|html|css|scss|sh|txt|lock|sql)$/i.test(path);
  if (!hasPath && !hasExtension) return undefined;
  if (/^\d+\/\d+$/.test(path)) return undefined;
  const last = path.split(/[/\\]/).at(-1) ?? '';
  return !last || !/\.[\w-]+$/.test(last) ? 'folder' : 'file';
}

export function withReferences<T extends Renderer>(renderer: T): T {
  const code = renderer.codespan.bind(renderer);
  renderer.codespan = token => {
    const html = code(token);
    const kind = referenceKind(token.text);
    return kind ? html.replace('<code>', `<code class="inline-reference ${kind}-reference">`) : html;
  };
  const link = renderer.link.bind(renderer);
  renderer.link = token => {
    const html = link(token);
    try {
      const url = new URL(token.href);
      if (!/^https?:$/.test(url.protocol)) return html;
      // Fetch only the linked site's icon, never a third-party favicon service.
      const favicon = url.protocol === 'https:' && !url.hostname.includes(':') && url.hostname !== 'localhost' && !/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)
        ? `<img src="${url.origin}/favicon.ico" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : '';
      return html.replace('<a ', '<a class="site-reference" ').replace(/(<a\b[^>]*>)/, `$1<span class="link-site-icon" aria-hidden="true">${favicon}</span>`);
    } catch { return html; }
  };
  return renderer;
}

/** One document listener; no per-link handlers or scanning while tokens stream. */
export function installReferenceIconFallback(): () => void {
  const onError = (event: Event) => {
    if (event.target instanceof HTMLImageElement && event.target.parentElement?.classList.contains('link-site-icon')) event.target.hidden = true;
  };
  document.addEventListener('error', onError, true);
  return () => document.removeEventListener('error', onError, true);
}

const DARK_MONO_FAVICON_HOSTS = new Set([
  'github.com',
  'x.com',
  'twitter.com',
  'vercel.com',
  'nextjs.org',
  'apple.com',
  'openai.com',
  'anthropic.com',
  'notion.so',
  'notion.site',
  'medium.com',
  'dev.to',
  'rust-lang.org',
  'deno.com',
  'deno.land',
  'ollama.com',
  'wikipedia.org',
  'codepen.io',
  'codesandbox.io',
  'prisma.io',
  'resend.com',
  'shadcn.com',
  'threads.net',
  'uber.com',
  'opencode.ai',
  'linear.app',
  'obsidian.md'
]);

/** Direct origin favicon URL for public HTTPS hosts; never hits third-party icon proxies. */
export function faviconUrlFor(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:') return null;
    if (
      url.hostname.includes(':') ||
      url.hostname === 'localhost' ||
      /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)
    ) {
      return null;
    }
    return `${url.origin}/favicon.ico`;
  } catch {
    return null;
  }
}

/** Clean display hostname without leading `www.`. */
export function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/** True when a site serves a black monochrome transparent favicon that disappears on dark surfaces. */
export function needsDarkModeInvert(hostOrUrl: string): boolean {
  let host = String(hostOrUrl || '').trim().toLowerCase();
  if (!host) return false;
  if (host.includes('://')) {
    try {
      host = new URL(host).hostname.toLowerCase();
    } catch {
      return false;
    }
  }
  host = host.replace(/^www\./, '').replace(/\.+$/, '');
  for (const domain of DARK_MONO_FAVICON_HOSTS) {
    if (host === domain || host.endsWith(`.${domain}`)) return true;
  }
  return false;
}

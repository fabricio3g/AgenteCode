// Headless browser control using Puppeteer (if installed)
// Falls back to no-op if puppeteer is not available

type BrowserPage = {
  goto: (url: string, opts: { waitUntil: 'networkidle2'; timeout: number }) => Promise<void>;
  newPage?: never;
  evaluate: <T>(fn: ((...args: unknown[]) => T) | string, ...args: unknown[]) => Promise<T>;
  setViewport: (opts: { width: number; height: number }) => Promise<void>;
  waitForNetworkIdle: (opts: { timeout: number }) => Promise<void>;
  type: (selector: string, text: string) => Promise<void>;
  screenshot: (opts: { encoding: 'base64' }) => Promise<string>;
  url: () => string;
  close: () => Promise<void>;
};

type BrowserInstance = {
  newPage: () => Promise<BrowserPage>;
  close: () => Promise<void>;
};

let browser: BrowserInstance | null = null;
let page: BrowserPage | null = null;

const SNAPSHOT_SCRIPT = () => ({
  url: location.href,
  title: document.title,
  text: document.body?.innerText?.slice(0, 10000) || '',
  links: Array.from(document.querySelectorAll('a[href]')).slice(0, 50).map(a => ({
    text: (a as HTMLAnchorElement).innerText?.trim().slice(0, 100) || '',
    href: (a as HTMLAnchorElement).href
  })),
  inputs: Array.from(document.querySelectorAll('input, textarea, select')).slice(0, 30).map((el, i) => ({
    index: i,
    kind: el.tagName.toLowerCase() + ((el as HTMLInputElement).type ? `:${(el as HTMLInputElement).type}` : ''),
    name: (el as HTMLInputElement).name || '',
    placeholder: (el as HTMLInputElement).placeholder || ''
  })),
  buttons: Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]')).slice(0, 30).map((el, i) => ({
    index: i,
    text: ((el as HTMLElement).innerText?.trim().slice(0, 100) || (el as HTMLInputElement).value || '')
  }))
});

async function ensureBrowser(): Promise<BrowserPage> {
  if (browser && page) return page;

  try {
    const puppeteer = await import('puppeteer').catch(() => null);
    if (!puppeteer) {
      throw new Error('Puppeteer not installed. Install with: npm install puppeteer');
    }
    browser = await puppeteer.launch({
      headless: 'new'
    }) as unknown as BrowserInstance;
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    return page;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Browser control not available: ${message}`);
  }
}

async function readSnapshot() {
  const p = await ensureBrowser();
  return p.evaluate(SNAPSHOT_SCRIPT);
}

export async function browserNavigate(url: string) {
  const p = await ensureBrowser();
  await p.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  return readSnapshot();
}

export async function browserSnapshot() {
  return readSnapshot();
}

export async function browserClick(text: string) {
  const p = await ensureBrowser();
  await p.evaluate((txt) => {
    const els = [...document.querySelectorAll('a, button, [role="button"], input[type="submit"]')];
    const match = els.find(el => (el.innerText || el.value || '').trim().toLowerCase().includes(txt.toLowerCase()));
    if (match) match.click();
  }, text);
  await p.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});
  return browserSnapshot();
}

export async function browserTypeText(selector: string, text: string) {
  const p = await ensureBrowser();
  await p.type(selector, text);
  return 'ok';
}

export async function browserEvaluate(script: string) {
  const p = await ensureBrowser();
  const result = await p.evaluate(script);
  return String(result ?? '');
}

export async function browserScreenshot() {
  const p = await ensureBrowser();
  const buf = await p.screenshot({ encoding: 'base64' });
  return `data:image/png;base64,${buf}`;
}

export async function browserGetCurrentUrl() {
  const p = await ensureBrowser();
  return p.url();
}

export async function browserClose() {
  if (page) { await page.close().catch(() => {}); page = null; }
  if (browser) { await browser.close().catch(() => {}); browser = null; }
}

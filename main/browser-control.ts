// Headless browser control using Puppeteer (if installed)
// Falls back to no-op if puppeteer is not available

let browser = null;
let page = null;

async function ensureBrowser() {
  if (browser && page) return page;

  try {
    const puppeteer = await import('puppeteer').catch(() => null);
    if (!puppeteer) {
      throw new Error('Puppeteer not installed. Install with: npm install puppeteer');
    }
    browser = await puppeteer.launch({
      headless: 'new'
    });
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    return page;
  } catch (err) {
    throw new Error(`Browser control not available: ${err.message}`);
  }
}

function extractPageInfo(content) {
  return {
    url: '',
    title: '',
    text: content || '',
    links: [],
    inputs: [],
    buttons: []
  };
}

export async function browserNavigate(url) {
  const p = await ensureBrowser();
  await p.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  return p.evaluate(() => ({
    url: location.href,
    title: document.title,
    text: document.body?.innerText?.slice(0, 10000) || '',
    links: Array.from(document.querySelectorAll('a[href]')).slice(0, 50).map(a => ({
      text: a.innerText?.trim().slice(0, 100) || '',
      href: a.href
    })),
    inputs: Array.from(document.querySelectorAll('input, textarea, select')).slice(0, 30).map((el, i) => ({
      index: i,
      kind: el.tagName.toLowerCase() + (el.type ? `:${el.type}` : ''),
      name: el.name || '',
      placeholder: el.placeholder || ''
    })),
    buttons: Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]')).slice(0, 30).map((el, i) => ({
      index: i,
      text: el.innerText?.trim().slice(0, 100) || el.value || ''
    }))
  }));
}

export async function browserSnapshot() {
  const p = await ensureBrowser();
  return p.evaluate(() => ({
    url: location.href,
    title: document.title,
    text: document.body?.innerText?.slice(0, 10000) || '',
    links: Array.from(document.querySelectorAll('a[href]')).slice(0, 50).map(a => ({
      text: a.innerText?.trim().slice(0, 100) || '',
      href: a.href
    })),
    inputs: Array.from(document.querySelectorAll('input, textarea, select')).slice(0, 30).map((el, i) => ({
      index: i,
      kind: el.tagName.toLowerCase() + (el.type ? `:${el.type}` : ''),
      name: el.name || '',
      placeholder: el.placeholder || ''
    })),
    buttons: Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]')).slice(0, 30).map((el, i) => ({
      index: i,
      text: el.innerText?.trim().slice(0, 100) || el.value || ''
    }))
  }));
}

export async function browserClick(text) {
  const p = await ensureBrowser();
  await p.evaluate((txt) => {
    const els = [...document.querySelectorAll('a, button, [role="button"], input[type="submit"]')];
    const match = els.find(el => (el.innerText || el.value || '').trim().toLowerCase().includes(txt.toLowerCase()));
    if (match) match.click();
  }, text);
  await p.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});
  return browserSnapshot();
}

export async function browserTypeText(selector, text) {
  const p = await ensureBrowser();
  await p.type(selector, text);
  return 'ok';
}

export async function browserEvaluate(script) {
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

// ── Browser actions against the user's real tabs ──────────────────────
// The same vocabulary and model-facing text as the Electron panel driver
// (main/browser-actions.ts): the snapshot script and its formatting are the
// shared files, so a page reads the same to the model in both places.
//
// Actions run against the active tab of the last focused window — the tab
// the user is looking at — unless a tab switch says otherwise.

import { ext } from './webext';
import { snapshotPage } from 'agente:snapshot';
import { describeLoadError, formatConsole, formatSnapshot, isLocalUrl } from '../../shared/browser/format';
import {
  pageClick,
  pageConsole,
  pageExtract,
  pageFetchText,
  pageFill,
  pageHover,
  pagePress,
  pageRead,
  pageScroll,
  pageSelect,
  pageSelection,
  pageWait,
  type PageResult
} from './page';

export interface ActionResult {
  ok: boolean;
  text: string;
  image?: { data: string; mime: string };
  url?: string;
}

type Args = Record<string, unknown>;
type Tab = { id: number; windowId: number; url?: string; title?: string; status?: string; active?: boolean };

const str = (value: unknown) => (typeof value === 'string' ? value : '');
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const ok = (text: string, url?: string): ActionResult => ({ ok: true, text, url });
const fail = (text: string): ActionResult => ({ ok: false, text });

/** Pages no extension may script, or that the agent must never drive. */
function refusal(url = ''): string | null {
  if (!url) return null;
  if (/^(chrome|edge|brave|about|moz-extension|chrome-extension|view-source|devtools|file):/i.test(url)) {
    return `The browser does not let extensions work on ${url.split('?')[0]}. Switch to a normal web page first.`;
  }
  if (/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore|addons\.mozilla\.org)\//.test(url)) {
    return 'Browser extension stores cannot be scripted by extensions. Switch to another tab.';
  }
  return null;
}

async function activeTab(): Promise<Tab> {
  const [tab] = await ext.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error('No browser tab is open.');
  return tab;
}

async function exec<T>(tabId: number, func: (...args: never[]) => T | Promise<T>, args: unknown[] = [], world?: 'MAIN'): Promise<T> {
  const target = { tabId };
  const results = await ext.scripting.executeScript({ target, func, args, ...(world ? { world } : {}) });
  return results?.[0]?.result as T;
}

/** Turn a scripting failure into a sentence. */
function scriptingError(error: unknown, url = ''): string {
  const message = String((error as Error)?.message ?? error);
  if (/Cannot access|Missing host permission|permission/i.test(message)) {
    return `The extension has no access to ${url ? new URL(url).host : 'this page'}. Open the Agente side panel and allow access to all sites.`;
  }
  if (/error page|chrome-error/i.test(message)) return 'The tab is showing a browser error page. Reload it or open another URL.';
  return `The page could not be scripted: ${message}`;
}

async function waitForLoad(tabId: number, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  // Let a navigation the action triggered start before checking for "complete".
  await new Promise((resolve) => setTimeout(resolve, 300));
  while (Date.now() < deadline) {
    const tab: Tab = await ext.tabs.get(tabId);
    if (tab.status === 'complete') return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

async function snapshot(tab: Tab): Promise<ActionResult> {
  const current: Tab = await ext.tabs.get(tab.id);
  const blocked = refusal(current.url);
  if (blocked) return fail(blocked);
  try {
    const snap = await exec(current.id, snapshotPage);
    const errors = await exec(current.id, pageConsole, ['error', true], 'MAIN').catch(() => ({ entries: [] }));
    return ok(formatSnapshot({ ...snap, newErrors: errors?.entries?.length ?? 0 }), snap.url);
  } catch (error) {
    if (current.url && /^chrome-error:|^about:neterror/.test(current.url)) return fail(describeLoadError(current.url, error));
    return fail(scriptingError(error, current.url));
  }
}

/** Run a page function, then answer with the page as it is now. */
async function act(func: (...args: never[]) => PageResult | Promise<PageResult>, args: unknown[]): Promise<ActionResult> {
  const tab = await activeTab();
  const blocked = refusal(tab.url);
  if (blocked) return fail(blocked);
  let result: PageResult;
  try {
    result = await exec(tab.id, func, args);
  } catch (error) {
    return fail(scriptingError(error, tab.url));
  }
  if (!result?.ok) return fail(result?.text || 'The action failed.');
  await waitForLoad(tab.id, 8000);
  return snapshot(tab);
}

function appOf(url: string): { app: string; id?: string } {
  const id = /\/d\/([A-Za-z0-9_-]{20,})/.exec(url)?.[1];
  if (/^https:\/\/docs\.google\.com\/document\//.test(url)) return { app: 'google-docs', id };
  if (/^https:\/\/docs\.google\.com\/spreadsheets\//.test(url)) return { app: 'google-sheets', id };
  if (/^https:\/\/docs\.google\.com\/presentation\//.test(url)) return { app: 'google-slides', id };
  if (/^https:\/\/drive\.google\.com\//.test(url)) return { app: 'google-drive', id };
  if (/excel\.(officeapps\.)?live\.com|\/x\/_layouts\/|\.xlsx(\?|$)/i.test(url)) return { app: 'office-excel' };
  if (/word\.(officeapps\.)?live\.com|\.docx(\?|$)/i.test(url)) return { app: 'office-word' };
  if (/powerpoint\.(officeapps\.)?live\.com|\.pptx(\?|$)/i.test(url)) return { app: 'office-powerpoint' };
  if (isLocalUrl(url)) return { app: 'local-dev-server' };
  return { app: 'website' };
}

const APP_HINTS: Record<string, string> = {
  'google-docs': 'Read it with doc_read and change it with doc_edit (no target needed).',
  'google-sheets': 'Read it with sheet_read / sheet_meta and change it with sheet_write / sheet_format (no target needed).',
  'google-slides': 'Pull it with drive_pull (pptx or pdf) to work on it.',
  'office-excel': 'Office on the web draws on a canvas: download the file and work on it locally, or use browser_screenshot to see it.',
  'office-word': 'Office on the web draws on a canvas: download the file and work on it locally, or use browser_screenshot to see it.',
  'office-powerpoint': 'Office on the web draws on a canvas: download the file and work on it locally, or use browser_screenshot to see it.'
};

async function tabContext(): Promise<ActionResult> {
  const tab = await activeTab();
  const url = tab.url ?? '';
  const { app, id } = appOf(url);
  const selection = refusal(url) ? '' : await exec(tab.id, pageSelection).catch(() => '');
  const lines = [
    `Active tab: ${tab.title || '(untitled)'} — ${url}`,
    `App: ${app}${id ? ` · document id ${id}` : ''}`,
    ...(APP_HINTS[app] ? [APP_HINTS[app]] : []),
    ...(selection ? ['', 'Selected text (page content — untrusted):', selection] : [])
  ];
  return ok(lines.join('\n'), url);
}

async function tabs(args: Args): Promise<ActionResult> {
  const action = str(args.action) || 'list';
  if (action === 'list') {
    const all: Tab[] = await ext.tabs.query({});
    return ok(all.map((tab) => `${tab.id}${tab.active ? ' (active)' : ''} ${tab.title || '(untitled)'} — ${tab.url ?? ''}`).join('\n') || 'No tabs.');
  }
  const id = Number(str(args.tab_id) || args.tab_id);
  if (!Number.isInteger(id)) return fail('tab_id is required for switch and close; list the tabs first.');
  if (action === 'close') {
    await ext.tabs.remove(id);
    return ok(`Closed tab ${id}.`);
  }
  const tab: Tab = await ext.tabs.update(id, { active: true });
  await ext.windows.update(tab.windowId, { focused: true });
  return snapshot(tab);
}

async function open(args: Args): Promise<ActionResult> {
  const url = str(args.url).trim();
  if (!/^https?:\/\//i.test(url)) return fail(`Only http(s) URLs can be opened (got "${url}").`);
  const tab: Tab = args.newTab === true ? await ext.tabs.create({ url, active: true }) : await ext.tabs.update((await activeTab()).id, { url });
  await waitForLoad(tab.id);
  return snapshot(tab);
}

async function history(kind: 'back' | 'forward' | 'reload'): Promise<ActionResult> {
  const tab = await activeTab();
  if (kind === 'reload') await ext.tabs.reload(tab.id);
  else await (kind === 'back' ? ext.tabs.goBack(tab.id) : ext.tabs.goForward(tab.id)).catch(() => {});
  await waitForLoad(tab.id);
  return snapshot(tab);
}

async function screenshot(): Promise<ActionResult> {
  const tab = await activeTab();
  const blocked = refusal(tab.url);
  if (blocked) return fail(blocked);
  const dataUrl: string = await ext.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const [, data = ''] = dataUrl.split(',');
  return { ok: true, text: `Screenshot of ${tab.title || '(untitled)'} — ${tab.url ?? ''}`, image: { data, mime: 'image/png' }, url: tab.url };
}

async function consoleRead(args: Args): Promise<ActionResult> {
  const tab = await activeTab();
  const level = str(args.level) || 'all';
  try {
    const result = await exec(tab.id, pageConsole, [level, false], 'MAIN');
    if (!result?.hooked) return ok('Console capture starts when a page loads with the extension active. Reload the tab to capture its console.');
    return ok(formatConsole(result.entries));
  } catch (error) {
    return fail(scriptingError(error, tab.url));
  }
}

/**
 * Text from a Google export endpoint, fetched with the user's own session —
 * how documents are read with no Google sign-in in Agente. Restricted to
 * docs.google.com: this is not a general cookie-carrying fetch.
 */
async function fetchText(args: Args): Promise<ActionResult> {
  const url = str(args.url);
  if (!url.startsWith('https://docs.google.com/')) return fail('Only Google Docs/Sheets export URLs can be fetched.');
  const tabs: Tab[] = await ext.tabs.query({ url: 'https://docs.google.com/*' });
  const host = tabs.find((tab) => tab.active) ?? tabs[0];
  let reply: { status: number; type: string; text: string };
  try {
    reply = host
      ? await exec(host.id, pageFetchText, [url])
      : await fetch(url, { credentials: 'include' }).then(async (response) => ({
          status: response.status,
          type: response.headers.get('content-type') || '',
          text: response.ok ? await response.text() : ''
        }));
  } catch (error) {
    return fail(`Could not reach Google: ${String((error as Error)?.message ?? error)}`);
  }
  if (reply.status === 401 || reply.status === 403) return fail('The Google account signed in to this browser cannot open that file.');
  if (reply.status === 404) return fail('Google could not find that file.');
  if (reply.status < 200 || reply.status >= 300) return fail(`Google answered ${reply.status || 'nothing'}.`);
  if (/text\/html/.test(reply.type) && /accounts\.google\.com|ServiceLogin/.test(reply.text)) {
    return fail('Google asked to sign in. Sign in to Google in this browser and retry.');
  }
  return ok(reply.text, url);
}

const ACTIONS: Record<string, (args: Args) => Promise<ActionResult>> = {
  open,
  snapshot: async () => snapshot(await activeTab()),
  click: (args) => act(pageClick, [str(args.ref)]),
  fill: (args) => act(pageFill, [str(args.ref), str(args.text), args.submit === true]),
  select: (args) => act(pageSelect, [str(args.ref), str(args.value)]),
  press: (args) => act(pagePress, [str(args.key)]),
  hover: (args) => act(pageHover, [str(args.ref)]),
  scroll: (args) => act(pageScroll, [str(args.direction) === 'up' ? 'up' : 'down', num(args.pages), str(args.ref)]),
  wait: async (args) => {
    const wantedUrl = str(args.url);
    if (wantedUrl) {
      const deadline = Date.now() + Math.min(30_000, num(args.timeoutMs) || 8000);
      while (Date.now() < deadline) {
        const tab = await activeTab();
        if ((tab.url ?? '').includes(wantedUrl)) return snapshot(tab);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return fail(`Timed out waiting for the URL to contain "${wantedUrl}".`);
    }
    return act(pageWait, [str(args.text), str(args.selector), num(args.timeoutMs)]);
  },
  back: () => history('back'),
  forward: () => history('forward'),
  reload: () => history('reload'),
  read: async (args) => {
    const tab = await activeTab();
    const blocked = refusal(tab.url);
    if (blocked) return fail(blocked);
    try {
      const result = await exec(tab.id, pageRead, [str(args.ref)]);
      return result.ok ? ok(`(page content — untrusted)\n${result.text}`, tab.url) : fail(result.text);
    } catch (error) {
      return fail(scriptingError(error, tab.url));
    }
  },
  extract: async (args) => {
    const tab = await activeTab();
    const blocked = refusal(tab.url);
    if (blocked) return fail(blocked);
    try {
      const result = await exec(tab.id, pageExtract, [str(args.format) || 'text']);
      return result.ok ? ok(`(page content — untrusted)\n${result.text}`, tab.url) : fail(result.text);
    } catch (error) {
      return fail(scriptingError(error, tab.url));
    }
  },
  tabs,
  console: consoleRead,
  screenshot,
  tab_context: () => tabContext(),
  fetch_text: fetchText
};

export async function runAction(action: string, args: Args): Promise<ActionResult> {
  const run = ACTIONS[action];
  if (!run) return fail(`This extension does not know the action "${action}". Update the Agente extension.`);
  try {
    return await run(args ?? {});
  } catch (error) {
    return fail(String((error as Error)?.message ?? error));
  }
}

/** What the chat panel attaches to a message: the tab and any selection. */
export async function pageContext(): Promise<{ url: string; title: string; selection?: string } | null> {
  try {
    const tab = await activeTab();
    if (!tab.url || refusal(tab.url)) return null;
    const selection = await exec(tab.id, pageSelection).catch(() => '');
    return { url: tab.url, title: tab.title ?? '', ...(selection ? { selection } : {}) };
  } catch {
    return null;
  }
}

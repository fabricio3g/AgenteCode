// ── Browser actions: one dispatcher for every agent ───────────────────
// The Code agent calls this in-process; the Home agent reaches it through the
// `browser_agent_action` IPC channel. Same actions, same model-facing text.

import { browserScope, withBrowserScope } from './browser-panel.ts';
import * as driver from './browser-driver.ts';
import { formatConsole, formatSnapshot, type BrowserSnapshot } from './browser-format.ts';

export type BrowserActionName =
  | 'open'
  | 'snapshot'
  | 'click'
  | 'fill'
  | 'select'
  | 'press'
  | 'hover'
  | 'scroll'
  | 'wait'
  | 'back'
  | 'forward'
  | 'reload'
  | 'console'
  | 'screenshot';

export interface BrowserActionResult {
  ok: boolean;
  /** Model-facing text: the page snapshot, console lines, or the error. */
  text: string;
  /** A screenshot, for models that can see images. */
  image?: { data: string; mimeType: string };
  url?: string;
}

const str = (value: unknown) => (typeof value === 'string' ? value : '');
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

type Args = Record<string, unknown>;

const page = async (snap: Promise<BrowserSnapshot>): Promise<BrowserActionResult> => {
  const result = await snap;
  return { ok: true, text: formatSnapshot(result), url: result.url };
};

/** One handler per action; every page-changing action answers with a fresh snapshot. */
const ACTIONS: Record<BrowserActionName, (args: Args) => Promise<BrowserActionResult>> = {
  open: (args) => page(driver.open(str(args.url), { newTab: args.newTab === true })),
  snapshot: () => page(driver.snapshot()),
  click: (args) => page(driver.click(str(args.ref))),
  fill: (args) => page(driver.fill(str(args.ref), str(args.text), { submit: args.submit === true })),
  select: (args) => page(driver.selectOption(str(args.ref), str(args.value))),
  press: (args) => page(driver.press(str(args.key))),
  hover: (args) => page(driver.hover(str(args.ref))),
  scroll: (args) => page(driver.scroll({ direction: args.direction === 'up' ? 'up' : 'down', pages: num(args.pages), ref: str(args.ref) || undefined })),
  wait: (args) =>
    page(driver.waitFor({ text: str(args.text) || undefined, selector: str(args.selector) || undefined, url: str(args.url) || undefined, timeoutMs: num(args.timeoutMs) })),
  back: () => page(driver.history('back')),
  forward: () => page(driver.history('forward')),
  reload: () => page(driver.history('reload')),
  console: async (args) => {
    const level = args.level === 'error' || args.level === 'warning' ? args.level : 'all';
    return { ok: true, text: formatConsole(driver.consoleEntries({ level })) };
  },
  screenshot: async () => {
    const image = await driver.screenshot();
    const snap = await driver.snapshot();
    return { ok: true, text: `Screenshot of ${snap.title || snap.url} (${snap.url}).`, image, url: snap.url };
  }
};

const queues = new Map<string, Promise<unknown>>();

/** Run an action; errors come back as text the model can act on, never throws. */
export async function runBrowserAction(action: BrowserActionName, args: Record<string, unknown> = {}, scope = browserScope()): Promise<BrowserActionResult> {
  const handler = ACTIONS[action];
  if (!handler) return { ok: false, text: `Unknown browser action "${String(action)}".` };
  try {
    const previous = queues.get(scope) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => withBrowserScope(scope, () => handler(args)));
    queues.set(scope, pending);
    try { return await pending; } finally { if (queues.get(scope) === pending) queues.delete(scope); }
  } catch (err: unknown) {
    return { ok: false, text: err instanceof Error ? err.message : String(err) };
  }
}

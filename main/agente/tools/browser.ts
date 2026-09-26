// ── Browser tools for the Code agent ───────────────────────────────────
// Drive the in-app agent browser to check the user's running app: open it,
// read a snapshot with element refs, click / fill / press / scroll, wait for
// something to appear, read console errors, and look at a screenshot.
// Local URLs (dev servers) need no approval; external sites ask in
// Supervised and Plan modes.

import { z } from 'zod';
import type { AgentTool } from '../../../shared/agent-core/types.ts';
import { defineTool } from './define-tool.ts';
import { runBrowserAction, type BrowserActionName } from '../../browser-actions.ts';
import { isLocalUrl } from '../../browser-format.ts';

export interface BrowserToolOptions {
  /** Whether the current model can take images (screenshots). */
  canSeeImages: () => boolean;
}

const ref = z.string().describe('Element ref from the latest browser_snapshot, e.g. "e12"');

function tool<T extends z.ZodType>(name: string, description: string, schema: T, action: BrowserActionName, extra: Partial<{ requiresApproval: (args: z.output<T>) => boolean }> = {}): AgentTool {
  return defineTool({
    name,
    description,
    schema,
    // The browser is one shared surface: actions must not interleave.
    executionMode: 'sequential',
    ...extra,
    async execute(args) {
      const result = await runBrowserAction(action, args as Record<string, unknown>);
      return { content: result.text, isError: !result.ok };
    }
  });
}

export function createBrowserTools(options: BrowserToolOptions): AgentTool[] {
  const screenshot = defineTool({
    name: 'browser_screenshot',
    description: 'Capture the visible page as an image to check layout and visual details. Prefer browser_snapshot for reading text and finding elements.',
    schema: z.object({}),
    executionMode: 'sequential',
    async execute() {
      const result = await runBrowserAction('screenshot');
      if (!result.ok || !result.image) return { content: result.text, isError: true };
      if (!options.canSeeImages()) {
        return { content: `${result.text} The current model cannot see images, so the screenshot was not attached — use browser_snapshot to read the page instead.` };
      }
      return { content: result.text, images: [result.image] };
    }
  });

  return [
    tool(
      'browser_open',
      'Open a URL in the in-app browser (the user sees it too) and return a snapshot of the page. Use it for the app you are building (e.g. http://localhost:5173) or documentation.',
      z.object({ url: z.string().describe('http(s) URL'), newTab: z.boolean().optional().describe('Open in a new tab instead of the current one') }),
      'open',
      { requiresApproval: (args) => !isLocalUrl(args.url) }
    ),
    tool('browser_snapshot', 'Read the current page: URL, title, every visible interactive element with a ref, new console errors, and the visible text.', z.object({}), 'snapshot'),
    tool('browser_click', 'Click an element by ref, wait for the page to settle, and return the new snapshot.', z.object({ ref }), 'click'),
    tool(
      'browser_fill',
      'Replace the content of a text field by ref. Set submit to press Enter afterwards (e.g. search boxes, login forms).',
      z.object({ ref, text: z.string(), submit: z.boolean().optional() }),
      'fill'
    ),
    tool('browser_select', 'Choose an option in a <select> by its value or visible label.', z.object({ ref, value: z.string() }), 'select'),
    tool(
      'browser_press',
      'Press a key in the page: Enter, Tab, Escape, Backspace, Delete, Space, ArrowUp/Down/Left/Right, PageUp, PageDown, Home, End.',
      z.object({ key: z.string() }),
      'press'
    ),
    tool('browser_hover', 'Move the pointer over an element by ref (menus, tooltips).', z.object({ ref }), 'hover'),
    tool(
      'browser_scroll',
      'Scroll the page by pages (default one, down), or scroll an element into view by ref.',
      z.object({ direction: z.enum(['up', 'down']).optional(), pages: z.number().optional(), ref: ref.optional() }),
      'scroll'
    ),
    tool(
      'browser_wait',
      'Wait until some text or a CSS selector appears, or the URL contains a string (default timeout 8s, max 30s).',
      z.object({ text: z.string().optional(), selector: z.string().optional(), url: z.string().optional(), timeoutMs: z.number().optional() }),
      'wait'
    ),
    tool('browser_back', 'Go back in the browser history.', z.object({}), 'back'),
    tool('browser_reload', 'Reload the page (after changing code, if the dev server does not hot-reload).', z.object({}), 'reload'),
    tool(
      'browser_console',
      "Read the page's console output, uncaught exceptions and failed network requests since the last check. Use level 'error' to see only problems.",
      z.object({ level: z.enum(['error', 'warning', 'all']).optional() }),
      'console'
    ),
    screenshot
  ];
}

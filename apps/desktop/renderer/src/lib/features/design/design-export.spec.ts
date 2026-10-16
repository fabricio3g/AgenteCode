// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('$lib/services/bridge', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { DEFAULT_EXPORT_WIDTH, exportRendered, exportWidthOf, pageHtml } from './design-export';

const files = { 'index.html': '<!doctype html><html><head></head><body><h1>Hi</h1></body></html>' };

describe('exportWidthOf', () => {
  it('uses the frame width, else the desktop default', () => {
    expect(exportWidthOf({ width: 390 })).toBe(390);
    expect(exportWidthOf({ width: 800.4 })).toBe(800);
    expect(exportWidthOf(null)).toBe(DEFAULT_EXPORT_WIDTH);
    expect(exportWidthOf({ width: 0 })).toBe(DEFAULT_EXPORT_WIDTH);
  });
});

describe('pageHtml', () => {
  it('inlines a page and answers null for a missing one', () => {
    expect(pageHtml(files, 'index.html')).toContain('<h1>Hi</h1>');
    expect(pageHtml(files, 'nope.html')).toBeNull();
  });
});

describe('exportRendered', () => {
  it('sends the rendered document and width to main', async () => {
    invoke.mockResolvedValueOnce({ saved: true });
    expect(await exportRendered('c1', files, 'index.html', 'png', 390)).toBe('saved');
    const [channel, request] = invoke.mock.calls.at(-1)!;
    expect(channel).toBe('design_manage');
    expect(request).toMatchObject({ chatId: 'c1', action: 'export_png', page: 'index.html', width: 390 });
    expect(request.html).toContain('<h1>Hi</h1>');
  });
  it('tells a cancelled dialog from a failure', async () => {
    invoke.mockResolvedValueOnce({ saved: false });
    expect(await exportRendered('c1', files, 'index.html', 'pdf', 1440)).toBe('cancelled');
    invoke.mockRejectedValueOnce(new Error('boom'));
    expect(await exportRendered('c1', files, 'index.html', 'pdf', 1440)).toBe('failed');
    expect(await exportRendered('c1', files, 'missing.html', 'pdf', 1440)).toBe('failed');
  });
});

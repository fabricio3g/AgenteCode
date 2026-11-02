import { describe, expect, it } from 'vitest';
import type { AgentTool } from '$shared/agent-core/types';
import { createDesignTools, pageFrom, renderSummary } from './design-tools';

const host = { chatId: 'c', step: () => () => {}, count: () => {}, vision: async () => false };
const stub = (name: string): AgentTool => ({ name, description: name, parameters: {}, execute: async () => ({ content: '' }) });

describe('createDesignTools', () => {
  it('offers the design tools, research, and only read-only web and browsing from Home', () => {
    const offered = ['web_search', 'fetch_url', 'bash', 'write_file', 'browser_open', 'browser_snapshot', 'browser_read', 'browser_tabs', 'browser_screenshot', 'browser_click', 'browser_fill', 'browser_press'];
    const borrowed = new Map(offered.map((name) => [name, stub(name)]));
    const names = [...createDesignTools(host, borrowed).keys()].sort();
    expect(names).toEqual([
      'browser_open', 'browser_read', 'browser_screenshot', 'browser_snapshot', 'browser_tabs', 'design_3d', 'design_edit', 'design_inspect', 'design_list',
      'design_motion', 'design_preview', 'design_read', 'design_reference', 'design_snapshot', 'design_view', 'design_write', 'fetch_url', 'web_search'
    ]);
  });

  it('runs workspace-changing tools one at a time', () => {
    const tools = createDesignTools(host);
    for (const name of ['design_write', 'design_edit', 'design_snapshot', 'design_preview', 'design_inspect', 'design_reference']) expect(tools.get(name)?.executionMode).toBe('sequential');
    expect(tools.get('design_read')?.executionMode).toBe('parallel');
    expect(tools.get('design_view')?.executionMode).toBe('parallel');
  });

  it('keeps a borrowed screenshot only for a model that can see it', async () => {
    const shot: AgentTool = { ...stub('browser_screenshot'), execute: async () => ({ content: 'Screenshot of x.', images: [{ data: 'AA==', mimeType: 'image/png' }] }) };
    const blind = createDesignTools({ ...host, vision: async () => false }, new Map([['browser_screenshot', shot]]));
    const hidden = await blind.get('browser_screenshot')!.execute('1', {}, {} as never);
    expect(hidden.images).toBeUndefined();
    expect(hidden.content).toContain('Screenshot not attached');
    const seeing = createDesignTools({ ...host, vision: async () => true }, new Map([['browser_screenshot', shot]]));
    expect((await seeing.get('browser_screenshot')!.execute('1', {}, {} as never)).images).toHaveLength(1);
  });
});

describe('pageFrom', () => {
  it('defaults to the entry page and trims a leading ./', () => {
    expect(pageFrom(undefined)).toBe('index.html');
    expect(pageFrom('./pricing.html')).toBe('pricing.html');
  });
});

describe('renderSummary', () => {
  it('tells the model about console errors and blocked network references', () => {
    const base = { ok: true, width: 390, height: 900, consoleErrors: [] as string[] };
    expect(renderSummary('index.html', base, [])).toBe('Rendered index.html at 390x900.\nNo console errors.');
    const text = renderSummary('index.html', { ...base, consoleErrors: ['boom'] }, ['https://cdn.example/x.css']);
    expect(text).toContain('- boom');
    expect(text).toContain('https://cdn.example/x.css');
  });
});

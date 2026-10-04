// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import SubagentCard from './SubagentCard.svelte';
vi.mock('$lib/services/bridge', () => ({ invoke: vi.fn() }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('defers reply rendering until opened and avoids duplicating the final answer', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const text = 'Unique final answer';
  const { container } = render(SubagentCard, { child: { id: 'child', kind: 'explore', description: 'Inspect files', status: 'done', text, summary: text, tools: [], spend: { costUsd: 0, estimated: false, unpriced: true, promptTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } } });
  expect(container.textContent).not.toContain(text);
  const details = container.querySelector('details')!;
  details.open = true;
  await fireEvent(details, new Event('toggle'));
  await waitFor(() => expect(container.textContent?.split(text)).toHaveLength(2));
});
it('shows failed child diagnostics on demand without treating them as an answer', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const diagnostic = 'Stream error: error reading a body from connection: stream closed because of a broken pipe';
  const { container } = render(SubagentCard, { child: { id:'failed', kind:'explore', description:'Inspect files', status:'error', text:diagnostic, summary:diagnostic, tools:[], spend:{costUsd:0,estimated:false,unpriced:true,promptTokens:0,cacheReadTokens:0,cacheWriteTokens:0} } });
  await waitFor(() => expect(container.querySelector('[role="alert"]')).toBeTruthy());
  expect(container.querySelector('.markdown-body')).toBeNull();
  expect(container.querySelector('pre')?.textContent).toBe(diagnostic);
  expect(container.querySelector('[role="alert"] details')?.hasAttribute('open')).toBe(false);
});

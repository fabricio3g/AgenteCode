// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SubagentCard from './SubagentCard.svelte';
import { disclosure } from './disclosure-state.svelte';
vi.mock('$lib/services/bridge', async (importOriginal) => ({
  ...await importOriginal<typeof import('$lib/services/bridge')>(),
  invoke: vi.fn()
}));

const spend = { costUsd: 0, estimated: false, unpriced: true, promptTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const child = (extra: Record<string, unknown> = {}) => ({ id: 'child', kind: 'explore', description: 'Inspect files', status: 'done', text: '', tools: [], spend, ...extra }) as never;

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); disclosure.clear(); });

it('reads as the agent it is: kind, description and what it is doing', () => {
  const { container } = render(SubagentCard, { child: child({ status: 'running', tools: [{ id: 't1', name: 'read_file', output: '', status: 'running' }] }), id: 'a' });
  const row = container.querySelector('.head')!.textContent!.replace(/\s+/g, ' ');
  expect(row).toContain('Explore');
  expect(row).toContain('Inspect files');
  expect(row).toContain('Reading');
  expect(container.querySelector('.level-subagent.is-card')).toBeNull();
  expect(container.querySelectorAll('.tile-rain .tile')).toHaveLength(8);
  expect(container.textContent).not.toContain('{');
});

it('keeps every child folded until the reader opens it', () => {
  for (const [status, expected] of [['running', false], ['error', false], ['done', false]] as const) {
    disclosure.clear();
    const { container } = render(SubagentCard, { child: child({ status }), id: `k-${status}` });
    expect(container.querySelector('.body') !== null).toBe(expected);
    cleanup();
  }
});

it('keeps a finished answer out of the DOM until the reader opens it', () => {
  const text = 'Unique final answer';
  const { container } = render(SubagentCard, { child: child({ text, summary: text }), id: 'b' });
  expect(container.textContent).not.toContain(text);
  flushSync(() => (container.querySelector('.head') as HTMLButtonElement).click());
  expect(container.textContent).toContain(text);
});

it('shows a failed child its diagnostic instead of an answer', () => {
  const diagnostic = 'Stream error: error reading a body from connection: stream closed because of a broken pipe';
  const { container } = render(SubagentCard, { child: child({ status: 'error', text: diagnostic, summary: diagnostic }), id: 'c' });
  flushSync(() => (container.querySelector('.head') as HTMLButtonElement).click());
  expect(container.querySelector('[role="alert"]')).toBeTruthy();
  expect(container.querySelector('.markdown-body')).toBeNull();
  expect(container.querySelector('pre')?.textContent).toBe(diagnostic);
});

it('says nothing about spend twice', () => {
  const priced = { costUsd: 0.012, estimated: false, unpriced: false, promptTokens: 900, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const { container } = render(SubagentCard, { child: child({ spend: priced }), id: 'd' });
  flushSync(() => (container.querySelector('.head') as HTMLButtonElement).click());
  expect(container.textContent?.split('$0.012')).toHaveLength(2);
});

it('names the cache rate in the body when the provider reported one', () => {
  const cached = { costUsd: 0.012, estimated: false, unpriced: false, promptTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0 };
  const { container } = render(SubagentCard, { child: child({ spend: cached, summary: 'Done.' }), id: 'e' });
  flushSync(() => (container.querySelector('.head') as HTMLButtonElement).click());
  expect(container.textContent).toContain('90% cached');
});

it('renders a spawn whose child has not registered yet as the same row', () => {
  const { container } = render(SubagentCard, {
    child: child({ id: 'step-1', kind: 'explore', description: 'Map the transcript', status: 'running' }),
    id: 'f',
    pending: true
  });
  const row = container.querySelector('.head')!.textContent!.replace(/\s+/g, ' ');
  expect(row).toContain('Explore');
  expect(row).toContain('Starting');
});

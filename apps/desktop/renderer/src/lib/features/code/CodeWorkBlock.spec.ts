// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CodeWorkBlock from './CodeWorkBlock.svelte';
import { disclosure } from './disclosure-state.svelte';
vi.mock('$lib/services/bridge', async (importOriginal) => ({
  ...await importOriginal<typeof import('$lib/services/bridge')>(),
  invoke: vi.fn()
}));
vi.mock('$lib/utils/clipboard', () => ({ writeToClipboard: vi.fn(async () => true) }));
import { writeToClipboard } from '$lib/utils/clipboard';
beforeEach(()=>{vi.stubGlobal('ResizeObserver',class{observe(){} disconnect(){}});});
afterEach(()=>{cleanup();disclosure.clear();vi.unstubAllGlobals();});
it.each(['done'] as const)('keeps a %s work block closed until opened',async status=>{
  const view=render(CodeWorkBlock,{chatId:'c',messageId:'m',live:false,items:[{key:'s-a',step:{id:'a',type:'tool',toolName:'read',label:'Read',status,detail:'file.ts',output:'Full tool output'}},{key:'s-b',step:{id:'b',type:'tool',toolName:'read',label:'Read',status,detail:'other.ts',output:'Other output'}}]});
  const header=view.container.querySelector('.head') as HTMLButtonElement;
  expect(header.getAttribute('aria-expanded')).toBe('false');
  expect(view.container.textContent).not.toContain('file.ts');
  await fireEvent.click(header);
  expect(header.getAttribute('aria-expanded')).toBe('true');
  expect(view.container.textContent).toContain('file.ts');
});
it('opens failed work so the failed step is visible', () => {
  const view=render(CodeWorkBlock,{chatId:'c',messageId:'m',items:[{key:'a',step:{id:'a',type:'tool',toolName:'read',label:'Read',status:'done',detail:'a.ts'}},{key:'b',step:{id:'b',type:'tool',toolName:'bash',label:'Run',status:'error',detail:'npm test',output:'failed'}}]});
  expect((view.container.querySelector('.head') as HTMLButtonElement).getAttribute('aria-expanded')).toBe('true');
  expect(view.container.textContent).toContain('npm test');
});
it('shows live work by default and respects a reader who folds it', async () => {
  const view=render(CodeWorkBlock,{chatId:'c',messageId:'m',live:true,items:[{key:'s-a',step:{id:'a',type:'tool',toolName:'read',label:'Read',status:'running',detail:'file.ts'}},{key:'s-b',step:{id:'b',type:'tool',toolName:'read',label:'Read',status:'done',detail:'other.ts'}}]});
  const header=view.container.querySelector('.head') as HTMLButtonElement;
  expect(header.getAttribute('aria-expanded')).toBe('true');
  expect(view.container.textContent).toContain('file.ts');
  await fireEvent.click(header);
  expect(header.getAttribute('aria-expanded')).toBe('false');
});
it('reveals and copies the actual tool input and output', async () => {
  const view=render(CodeWorkBlock,{chatId:'c',messageId:'m',items:[{key:'s-a',step:{id:'a',type:'tool',toolName:'read',label:'Read',status:'done',detail:'file.ts',toolInput:'{"path":"file.ts"}',output:'file contents'}}]});
  await fireEvent.click(view.getByRole('button', { name: /Read/ }));
  expect(view.container.textContent).toContain('{"path":"file.ts"}');
  await fireEvent.click(view.getByRole('button', { name: 'Copy output' }));
  expect(writeToClipboard).toHaveBeenCalledWith('file contents');
});
it('never folds away a step waiting on your approval', async () => {
  const view=render(CodeWorkBlock,{chatId:'c',messageId:'m',live:true,items:[{key:'s-a',step:{id:'a',type:'tool',toolName:'read',label:'Read',status:'done',detail:'file.ts'}},{key:'s-b',step:{id:'b',type:'tool',toolName:'read',label:'Read',status:'done',detail:'other.ts'}},{key:'s-c',step:{id:'c',type:'tool',toolName:'edit',label:'Edit',status:'awaiting_approval',detail:'index.ts'}}]});
  const header=view.container.querySelector('.head') as HTMLButtonElement;
  await fireEvent.click(header);
  expect(header.getAttribute('aria-expanded')).toBe('false');
  expect(view.container.textContent).not.toContain('file.ts');
  expect(view.container.textContent).toContain('index.ts');
});
it('keeps a live child out of its work block until it returns', async () => {
  const items = [{ key: 'spawn', step: { id: 'spawn', type: 'tool' as const, toolName: 'task', label: 'Task', status: 'running' as const, detail: 'Inspect the project', subagentId: 'child' } }];
  const child = { id: 'child', kind: 'explore', description: 'Inspect the project', status: 'running' as const, text: '', tools: [], spend: { costUsd: 0, estimated: false, unpriced: true, promptTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  const view = render(CodeWorkBlock, { chatId: 'c', messageId: 'm', items, children: [child], activeChildIds: new Set(['child']) });
  expect(view.container.textContent).not.toContain('Inspect the project');
  await view.rerender({ activeChildIds: new Set() });
  expect(view.container.textContent).toContain('Inspect the project');
});

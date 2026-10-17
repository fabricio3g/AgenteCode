// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CodeWorkBlock from './CodeWorkBlock.svelte';
import { disclosure } from './disclosure.svelte';
vi.mock('$lib/services/bridge', async (importOriginal) => ({
  ...await importOriginal<typeof import('$lib/services/bridge')>(),
  invoke: vi.fn()
}));
beforeEach(()=>{vi.stubGlobal('ResizeObserver',class{observe(){} disconnect(){}});});
afterEach(()=>{cleanup();disclosure.clear();vi.unstubAllGlobals();});
it.each(['running','error','done'] as const)('keeps a %s work block closed until opened',async status=>{
  const view=render(CodeWorkBlock,{chatId:'c',messageId:'m',live:status==='running',items:[{key:'s-a',step:{id:'a',type:'tool',toolName:'read',label:'Read',status,detail:'file.ts',output:'Full tool output'}},{key:'s-b',step:{id:'b',type:'tool',toolName:'read',label:'Read',status,detail:'other.ts',output:'Other output'}}]});
  const header=view.container.querySelector('.head') as HTMLButtonElement;
  expect(header.getAttribute('aria-expanded')).toBe('false');
  expect(view.container.textContent).not.toContain('file.ts');
  await fireEvent.click(header);
  expect(header.getAttribute('aria-expanded')).toBe('true');
  expect(view.container.textContent).toContain('file.ts');
});
it('never folds away a step waiting on your approval', () => {
  const view=render(CodeWorkBlock,{chatId:'c',messageId:'m',live:true,items:[{key:'s-a',step:{id:'a',type:'tool',toolName:'read',label:'Read',status:'done',detail:'file.ts'}},{key:'s-b',step:{id:'b',type:'tool',toolName:'read',label:'Read',status:'done',detail:'other.ts'}},{key:'s-c',step:{id:'c',type:'tool',toolName:'edit',label:'Edit',status:'awaiting_approval',detail:'index.ts'}}]});
  const header=view.container.querySelector('.head') as HTMLButtonElement;
  expect(header.getAttribute('aria-expanded')).toBe('false');
  expect(view.container.textContent).not.toContain('file.ts');
  expect(view.container.textContent).toContain('index.ts');
});

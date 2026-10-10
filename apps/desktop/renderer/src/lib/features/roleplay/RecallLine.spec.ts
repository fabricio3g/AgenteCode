// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import RecallLine from './RecallLine.svelte';

afterEach(cleanup);

describe('Remembered line', () => {
  it('names what the budget trimmed without opening the memory list', () => {
    const view = render(RecallLine, {
      props: {
        recall: {
          memories: [],
          lore: [{ id: 'lore-a', title: 'The ferry' }],
          summary: false,
          trimmed: [{ kind: 'examples', count: 1 }, { kind: 'lore', count: 2 }, { kind: 'descriptions', count: 1 }, { kind: 'history', count: 4 }]
        }
      }
    });
    const notice = view.container.querySelector('.recall-trim');
    expect(notice?.textContent).toBe('Fit to the context window: example dialogue, 2 lore entries, shortened descriptions, 4 older messages.');
    expect(view.container.querySelector('.recall-list')).toBeNull();
  });

  it('shows the trim line alone when nothing was remembered', () => {
    const view = render(RecallLine, { props: { recall: { memories: [], lore: [], summary: false, trimmed: [{ kind: 'history', count: 3 }] } } });
    expect(view.container.querySelector('.recall-toggle')).toBeNull();
    expect(view.container.querySelector('.recall-trim')?.textContent).toContain('3 older messages');
  });

  it('keeps the memory toggle and draws nothing when neither exists', async () => {
    const remembered = render(RecallLine, { props: { recall: { memories: [{ id: 'm1', title: '**Oath**' }], lore: [], summary: true } } });
    expect(remembered.container.querySelector('.recall-trim')).toBeNull();
    const toggle = remembered.container.querySelector('.recall-toggle') as HTMLButtonElement;
    expect(toggle.textContent).toContain('Remembered · 2');
    await fireEvent.click(toggle);
    expect(remembered.container.querySelector('.recall-list')?.textContent).toContain('Oath');
    cleanup();
    const empty = render(RecallLine, { props: { recall: { memories: [], lore: [], summary: false } } });
    expect(empty.container.querySelector('.recall')).toBeNull();
  });
});

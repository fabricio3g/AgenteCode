// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ComposerAsk from './ComposerAsk.svelte';

afterEach(cleanup);

const options = [
  { id: 'allow', label: 'Allow' },
  { id: 'deny', label: 'Deny' }
];

function ask(onanswer = vi.fn<(id: string) => void>()) {
  const view = render(ComposerAsk, { question: 'Run npm test?', detail: 'npm test', options, onanswer });
  return { view, onanswer };
}

describe('composer ask', () => {
  it('lists every answer as a row and numbers it from the left edge', () => {
    ask();
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveTextContent('Allow');
    expect(buttons[1]).toHaveTextContent('Deny');
    expect(buttons[0]?.querySelector('.key')?.textContent).toBe('1');
    expect(buttons[1]?.querySelector('.key')?.textContent).toBe('2');
  });

  it('answers the first option on Enter and the last on Escape', async () => {
    const { onanswer } = ask();
    await fireEvent.keyDown(window, { key: 'Enter' });
    expect(onanswer).toHaveBeenCalledWith('allow');
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(onanswer).toHaveBeenLastCalledWith('deny');
  });

  it('takes a number key as the option it labels', async () => {
    const { onanswer } = ask();
    await fireEvent.keyDown(window, { key: '2' });
    expect(onanswer).toHaveBeenCalledWith('deny');
  });

  it('never answers while the caret is in the field', async () => {
    const { onanswer } = ask();
    const textarea = document.createElement('textarea');
    document.body.append(textarea);
    await fireEvent.keyDown(textarea, { key: 'Enter' });
    await fireEvent.keyDown(textarea, { key: '1' });
    expect(onanswer).not.toHaveBeenCalled();
    textarea.remove();
  });

  it('answers when a row is clicked', async () => {
    const { onanswer } = ask();
    await fireEvent.click(screen.getByRole('button', { name: /Deny/ }));
    expect(onanswer).toHaveBeenCalledWith('deny');
  });

  it('stops listening once the question is gone', async () => {
    const { view, onanswer } = ask();
    view.unmount();
    await fireEvent.keyDown(window, { key: 'Enter' });
    expect(onanswer).not.toHaveBeenCalled();
  });
});
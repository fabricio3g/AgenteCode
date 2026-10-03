// @vitest-environment jsdom
import { render, fireEvent } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import PromptQueue from './PromptQueue.svelte';

describe('editable prompt queue', () => {
  it('saves an inline edit before sending and supports cancellation and removal', async () => {
    const calls: string[] = [];
    const onupdate = vi.fn((_id: string, text: string) => calls.push(text));
    const onremove = vi.fn();
    const onsend = vi.fn(() => calls.push('send'));
    const view = render(PromptQueue, { items: [{ id: 'one', content: 'Original prompt' }], onupdate, onremove, onsend });
    await fireEvent.click(view.getByRole('button', { name: 'Edit queued prompt' }));
    const editor = view.getByRole('textbox');
    await fireEvent.input(editor, { target: { value: 'Edited prompt' } });
    await fireEvent.click(view.getByRole('button', { name: 'Send queued prompts now' }));
    expect(calls).toEqual(['Edited prompt', 'send']);
    await fireEvent.click(view.getByRole('button', { name: 'Edit queued prompt' }));
    await fireEvent.input(view.getByRole('textbox'), { target: { value: 'Discard me' } });
    await fireEvent.keyDown(view.getByRole('textbox'), { key: 'Escape' });
    expect(onupdate).toHaveBeenCalledTimes(1);
    await fireEvent.click(view.getByRole('button', { name: 'Remove queued prompt' }));
    expect(onremove).toHaveBeenCalledWith('one');
  });

  it('locks prompts already handed to the engine', () => {
    const view = render(PromptQueue, { items: [{ id: 'one', content: 'Accepted', sending: true }], onupdate: vi.fn(), onremove: vi.fn(), onsend: vi.fn() });
    expect(view.queryByRole('button', { name: 'Edit queued prompt' })).toBeNull();
    expect(view.queryByRole('button', { name: 'Remove queued prompt' })).toBeNull();
    expect((view.getByRole('button', { name: 'Send queued prompts now' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

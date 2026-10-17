// @vitest-environment jsdom
import { render, fireEvent } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import PromptQueue from './PromptQueue.svelte';

describe('waiting-for-the-agent panel', () => {
  it('edits, cancels, sends and removes a held prompt', async () => {
    const onupdate = vi.fn();
    const onremove = vi.fn();
    const onsend = vi.fn();
    const view = render(PromptQueue, { items: [{ id: 'one', content: 'Original prompt' }], onupdate, onremove, onsend });
    await fireEvent.click(view.getByRole('button', { name: 'Edit queued prompt' }));
    await fireEvent.input(view.getByRole('textbox'), { target: { value: 'Edited prompt' } });
    await fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter' });
    expect(onupdate).toHaveBeenCalledWith('one', 'Edited prompt');
    await fireEvent.click(view.getByRole('button', { name: 'Edit queued prompt' }));
    await fireEvent.input(view.getByRole('textbox'), { target: { value: 'Discard me' } });
    await fireEvent.keyDown(view.getByRole('textbox'), { key: 'Escape' });
    expect(onupdate).toHaveBeenCalledTimes(1);
    await fireEvent.click(view.getByRole('button', { name: 'Send now' }));
    expect(onsend).toHaveBeenCalledWith('one');
    await fireEvent.click(view.getByRole('button', { name: 'Remove queued prompt' }));
    expect(onremove).toHaveBeenCalledWith('one');
  });

  it('names each lane while a run works, and only says steer where the runtime steers', () => {
    const items = [{ id: 'next', content: 'Use the helper', sending: true }, { id: 'later', content: 'Then add a test' }];
    const props = { items, running: true, onupdate: vi.fn(), onremove: vi.fn(), onsend: vi.fn() };
    const code = render(PromptQueue, { ...props, steers: true });
    expect(code.getByText('Waiting for the agent')).toBeTruthy();
    expect(code.getByText('Next step')).toBeTruthy();
    expect(code.getByText('After run')).toBeTruthy();
    expect(code.getByRole('button', { name: 'Steer now' })).toBeTruthy();
    code.unmount();
    const home = render(PromptQueue, props);
    expect(home.queryByRole('button', { name: 'Steer now' })).toBeNull();
    expect(home.getByRole('button', { name: 'Send now' })).toBeTruthy();
  });

  it('steers every held prompt at once from the header when more than one waits', async () => {
    const onsend = vi.fn();
    const items = [{ id: 'a', content: 'First' }, { id: 'b', content: 'Second' }];
    const view = render(PromptQueue, { items, running: true, steers: true, onupdate: vi.fn(), onremove: vi.fn(), onsend });
    expect(view.getAllByRole('button', { name: 'Steer now' })).toHaveLength(2);
    await fireEvent.click(view.getByRole('button', { name: 'Steer all' }));
    expect(onsend).toHaveBeenCalledWith();
    view.unmount();
    const one = render(PromptQueue, { items: items.slice(0, 1), running: true, steers: true, onupdate: vi.fn(), onremove: vi.fn(), onsend });
    expect(one.queryByRole('button', { name: 'Steer all' })).toBeNull();
  });

  it('locks a steer already handed to the engine', () => {
    const view = render(PromptQueue, { items: [{ id: 'one', content: 'Accepted', sending: true }], running: true, steers: true, onupdate: vi.fn(), onremove: vi.fn(), onsend: vi.fn() });
    expect(view.queryByRole('button', { name: 'Edit queued prompt' })).toBeNull();
    expect(view.queryByRole('button', { name: 'Remove queued prompt' })).toBeNull();
    expect(view.queryByRole('button', { name: 'Steer now' })).toBeNull();
  });
});

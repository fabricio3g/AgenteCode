// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import ControlsHost from './__fixtures__/ControlsHost.svelte';
afterEach(cleanup);
describe('shared viewer controls', () => {
  it('validates editable page numbers, restoring invalid input', async () => {
    const view = render(ControlsHost);
    const input = view.container.querySelector('.page-number') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: '7' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('7');
    await fireEvent.input(input, { target: { value: '13' } });
    await fireEvent.blur(input);
    expect(input.value).toBe('7');
    await fireEvent.input(input, { target: { value: '2.5' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('7');
  });
  it('clears capabilities on file switches and does not expose unsupported controls', async () => {
    const view = render(ControlsHost);
    expect(view.container.querySelector('.page-number')).toBeTruthy();
    await view.rerender({ paged: false });
    await waitFor(() => expect(view.container.querySelector('.page-number')).toBeNull());
    expect(view.container.querySelector('.zoom-label')).toBeNull();
    expect(view.container.querySelector('.viewer-find')).toBeNull();
  });
  it('keeps reader shortcuts independent and closes find before the enclosing dialog', async () => {
    const first = render(ControlsHost, { name: 'First' });
    const second = render(ControlsHost, { name: 'Second' });
    const a = first.container.querySelector('[data-reader]')!;
    const b = second.container.querySelector('[data-reader]')!;
    await fireEvent.keyDown(a, { key: 'f', ctrlKey: true });
    expect(first.container.querySelector('.viewer-find')).toBeTruthy();
    expect(second.container.querySelector('.viewer-find')).toBeNull();
    const field = first.container.querySelector('.viewer-find input')!;
    await fireEvent.input(field, { target: { value: 'reader' } });
    await fireEvent.keyDown(field, { key: 'Escape' });
    expect(first.container.querySelector('.viewer-find')).toBeNull();
    await fireEvent.keyDown(b, { key: '+', ctrlKey: true });
    expect(second.container.querySelector('.zoom-label')?.textContent).toBe('2');
    expect(first.container.querySelector('.zoom-label')?.textContent).toBe('1');
    first.unmount();
    await fireEvent.keyDown(b, { key: '0', ctrlKey: true });
    expect(second.container.querySelector('.zoom-label')?.textContent).toBe('1');
  });
});

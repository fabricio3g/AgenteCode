// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LoadSizeControl from './LoadSizeControl.svelte';

afterEach(() => cleanup());

function setup(props: Partial<{ value: number; auto: boolean; min: number; max: number; kind: 'context' | 'layers'; leaveAuto: number }> = {}) {
  const onchange = vi.fn();
  const view = render(LoadSizeControl, {
    props: { label: 'Context length', value: 262144, auto: true, min: 512, max: 262144, kind: 'context' as const, onchange, ...props }
  });
  return { onchange, view };
}

describe('LoadSizeControl', () => {
  it('changes nothing by being shown or re-rendered with a new range', async () => {
    const { onchange, view } = setup({ kind: 'layers', value: 80, max: 80, min: 0 });
    // The model's real layer count arrives after the dialog opens.
    await view.rerender({ label: 'GPU layers', value: 24, auto: true, min: 0, max: 24, kind: 'layers', onchange });
    expect(onchange).not.toHaveBeenCalled();
  });

  it('only a slider move takes the value off auto', async () => {
    const { onchange, view } = setup();
    const slider = view.container.querySelector('input[type="range"]') as HTMLInputElement;
    await fireEvent.input(slider, { target: { value: '500' } });
    expect(onchange).toHaveBeenCalledTimes(1);
    expect(onchange.mock.calls[0][0]).toBeLessThan(262144);
  });

  it('typing elsewhere in the dialog does not reach the slider', async () => {
    const { onchange, view } = setup();
    const outside = document.createElement('input');
    view.container.appendChild(outside);
    await fireEvent.input(outside, { target: { value: '' } });
    expect(onchange).not.toHaveBeenCalled();
  });

  it('switching Auto off starts from the given value, not the maximum', async () => {
    const { onchange, view } = setup({ leaveAuto: 32768 });
    const chip = [...view.container.querySelectorAll('button')].find((button) => button.getAttribute('aria-pressed') === 'true')!;
    await fireEvent.click(chip);
    expect(onchange).toHaveBeenCalledWith(32768);
  });

  it('typing a size commits it on Enter and blank means auto', async () => {
    const { onchange, view } = setup({ auto: false, value: 32768 });
    const field = view.container.querySelector('input:not([type="range"])') as HTMLInputElement;
    await fireEvent.input(field, { target: { value: '64k' } });
    await fireEvent.keyDown(field, { key: 'Enter' });
    expect(onchange).toHaveBeenLastCalledWith(65536);
    await fireEvent.input(field, { target: { value: '' } });
    await fireEvent.blur(field);
    expect(onchange).toHaveBeenLastCalledWith(null);
  });
});

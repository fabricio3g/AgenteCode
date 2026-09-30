// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NameCompletion from './NameCompletion.svelte';

afterEach(() => { cleanup(); document.body.innerHTML = ''; });

describe('completion keyboard behavior', () => {
  async function setup(text = '@Wr') {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.append(textarea);
    textarea.focus();
    textarea.setSelectionRange(text.length, text.length);
    const onchange = vi.fn();
    const submit = vi.fn();
    const view = render(NameCompletion, { props: { textarea, text, candidates: [{ id: 'wren', name: 'Wren' }, { id: 'wray', name: 'Wray' }], onchange } });
    // Simulate the composer's normal handler after the completion capture hook.
    textarea.addEventListener('keydown', submit);
    await tick();
    return { textarea, onchange, submit, view };
  }

  it('Enter completes, arrow keys select, and completion never reaches the submit handler', async () => {
    const { textarea, onchange, submit, view } = await setup();
    expect(view.getAllByRole('option')).toHaveLength(2);
    await fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    await fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onchange).toHaveBeenCalledWith('@Wray ');
    expect(submit).not.toHaveBeenCalled();
  });

  it('Escape dismisses, and IME composition is not intercepted', async () => {
    const { textarea, onchange, submit, view } = await setup();
    await fireEvent.compositionStart(textarea);
    await fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });
    expect(onchange).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledOnce();
    await fireEvent.compositionEnd(textarea);
    expect(view.getAllByRole('option')).toHaveLength(2);
    await fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(view.queryByRole('listbox')).toBeNull();
  });
});

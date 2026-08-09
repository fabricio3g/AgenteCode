// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import ModelSearchField from './ModelSearchField.svelte';

afterEach(cleanup);

describe('ModelSearchField', () => {
  it('binds input and clears it from the accessible clear button', async () => {
    const view = render(ModelSearchField, {
      props: {
        value: 'llama',
        placeholder: 'Search GGUF models…',
        label: 'Search GGUF models',
      },
    });
    const input = view.getByRole('textbox', { name: 'Search GGUF models' }) as HTMLInputElement;
    expect(input.value).toBe('llama');

    await fireEvent.input(input, { target: { value: 'mistral' } });
    expect(input.value).toBe('mistral');
    await fireEvent.click(view.getByRole('button', { name: 'Clear search' }));
    expect(input.value).toBe('');
    expect(view.queryByRole('button', { name: 'Clear search' })).toBeNull();
  });

  it('clears a focused query with Escape', async () => {
    const view = render(ModelSearchField, {
      props: {
        value: 'qwen',
        placeholder: 'Filter downloaded models…',
        label: 'Filter downloaded models',
        clearLabel: 'Clear downloaded model filter',
      },
    });
    const input = view.getByRole('textbox', { name: 'Filter downloaded models' }) as HTMLInputElement;
    input.focus();
    await fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(input);
  });
});

// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CodeEditor from './CodeEditor.svelte';

const mock = vi.hoisted(() => {
  const model = { dispose: vi.fn() };
  let content = '';
  const editor = {
    getValue: () => content,
    setValue: vi.fn((value: string) => { content = value; }),
    getModel: () => model,
    updateOptions: vi.fn(), dispose: vi.fn(),
    onDidChangeModelContent: vi.fn(() => ({ dispose: vi.fn() }))
  };
  return { editor, model, create: vi.fn((_el: unknown, options: { value: string }) => { content = options.value; return editor; }), setModelLanguage: vi.fn(), setTheme: vi.fn() };
});
vi.mock('monaco-editor', () => ({ editor: { create: mock.create, setModelLanguage: mock.setModelLanguage, setTheme: mock.setTheme } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); document.documentElement.classList.remove('dark'); });

describe('artifact source editor', () => {
  it('updates external content, language and read-only state after async loading', async () => {
    const view = render(CodeEditor, { value: 'first', language: 'js' });
    await waitFor(() => expect(mock.create).toHaveBeenCalledOnce());
    await view.rerender({ value: 'second', language: 'css', readOnly: true });
    await waitFor(() => expect(mock.editor.getValue()).toBe('second'));
    expect(mock.setModelLanguage).toHaveBeenCalledWith(mock.model, 'css');
    expect(mock.editor.updateOptions).toHaveBeenCalledWith({ readOnly: true });
    document.documentElement.classList.add('dark');
    await waitFor(() => expect(mock.setTheme).toHaveBeenCalledWith('vs-dark'));
    view.unmount();
    expect(mock.editor.dispose).toHaveBeenCalledOnce();
    expect(mock.model.dispose).toHaveBeenCalledOnce();
  });
});

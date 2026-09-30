// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { roleplayStore } from './roleplay.svelte';
import PromptInspectorModal from './PromptInspectorModal.svelte';

afterEach(() => { cleanup(); vi.restoreAllMocks(); document.body.innerHTML = ''; });

describe('prompt inspector overlay', () => {
  it('escapes the animated transcript, locks page scroll and restores focus on close', async () => {
    vi.spyOn(roleplayStore, 'previewPrompt').mockReturnValue({ systemPrompt: 'Speak naturally.', loreEntries: [], speaker: null });
    const transcript = document.createElement('div');
    transcript.style.transform = 'translateY(0)';
    transcript.style.overflow = 'hidden';
    document.body.append(transcript);
    const trigger = document.createElement('button');
    trigger.textContent = 'Prompt';
    transcript.append(trigger);
    trigger.focus();
    const close = vi.fn();
    const view = render(PromptInspectorModal, { target: transcript, props: { messageId: 'message', onclose: close } });
    await tick();
    const dialog = screen.getByRole('dialog', { name: 'What the model saw' });
    expect(transcript.contains(dialog)).toBe(false);
    expect(dialog.parentElement?.parentElement?.parentElement).toBe(document.body);
    expect(document.body.style.overflow).toBe('hidden');
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(close).toHaveBeenCalledOnce();
    view.unmount();
    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement).toBe(trigger);
  });
});

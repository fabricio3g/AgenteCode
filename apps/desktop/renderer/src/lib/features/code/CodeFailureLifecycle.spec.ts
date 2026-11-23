// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodeChild } from '$shared/agente-protocol';
import type { ChatMessage, ChatSession } from '$lib/types/chat';
import { createCodeRunState, emptySpend } from './code-run';
import { codeStore } from './code.svelte';
import CodeTranscript from './CodeTranscript.svelte';
import SubagentPill from './SubagentPill.svelte';

const diagnostic = 'HTTP 400 invalid request Authorization: Bearer example-secret';
const summary = 'The provider rejected this request. Check your model and provider settings.';

function failedTurn(id: string): ChatMessage {
  return { id, role: 'assistant', content: '', createdAt: 1, status: 'error', done: true, metadata: { errorMessage: diagnostic } };
}

function child(id: string, status: CodeChild['status']): CodeChild {
  return { id, status, kind: 'explore', description: id, text: '', summary: status === 'error' ? diagnostic : undefined, tools: [], spend: emptySpend() };
}

function startRun(chatId: string, assistantMessageId: string, children: CodeChild[] = []) {
  codeStore.runs[chatId] = { ...createCodeRunState(), chatId, assistantMessageId, running: true, checkpoints: [], queuedCount: 0, children };
  return codeStore.runs[chatId]!;
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});

afterEach(() => {
  cleanup();
  codeStore.runs = {};
  vi.unstubAllGlobals();
});

describe('Code failure lifecycle', () => {
  it('keeps running children in the dock, then moves them to transcript history and resets the popover', async () => {
    const archived = child('Archived failure', 'error');
    const active = child('Running child', 'running');
    const messages: ChatMessage[] = [{ ...failedTurn('old'), metadata: { codeChildren: [archived], errorMessage: diagnostic } }];
    const chat: ChatSession = { id: 'chat', title: 'Code', createdAt: 1, updatedAt: 1, draft: '', folderId: null, contextMode: 'code', messages };
    const pill = render(SubagentPill, { chat });
    expect(pill.container.querySelector('[data-subagent-pill]')).toBeNull();

    const run = startRun(chat.id, 'active', [active, child('Settled child', 'done')]);
    const current: ChatMessage = { id: 'active', role: 'assistant', content: '', createdAt: 2, status: 'idle' };
    const transcript = render(CodeTranscript, { messages: [...messages, current], chatId: chat.id, liveSubagentDock: true });
    await tick();
    const trigger = pill.container.querySelector<HTMLButtonElement>('[data-subagent-pill]')!;
    trigger.focus();
    await fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const row = pill.getByRole('button', { name: /Running child/ });
    expect(document.activeElement).toBe(row);
    expect(pill.queryByRole('button', { name: /Archived failure/ })).toBeNull();
    expect(transcript.container.querySelector('[data-subagent-line="active"]')).toBeNull();
    await fireEvent.keyDown(row, { key: 'Escape' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);

    await fireEvent.click(trigger);
    pill.getByRole('button', { name: /Settled child/ }).focus();
    run.running = false;
    await tick();
    expect(document.activeElement).toBe(trigger);
    expect(pill.queryByRole('button', { name: /Running child/ })).not.toBeNull();
    run.children[0]!.status = 'error';
    await tick();
    expect(pill.container.querySelector('[data-subagent-pill]')).toBeNull();
    expect(transcript.container.querySelector('[data-subagent-line="active"]')?.textContent).toContain('1 failed');

    startRun(chat.id, 'next', [child('Next child', 'running')]);
    await tick();
    expect(pill.container.querySelector('[data-subagent-pill]')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('collapses a dismissed provider error across remounts and alerts for a new identical failure', async () => {
    const chatId = 'chat';
    const previous = failedTurn('previous');
    const current = failedTurn('current');
    const run = startRun(chatId, current.id);
    run.running = false;
    const transcript = render(CodeTranscript, { messages: [previous, current], chatId });
    const alert = transcript.getByRole('alert');
    expect(alert.textContent).toContain(summary);
    await fireEvent.click(transcript.getByRole('button', { name: 'Close' }));
    expect(transcript.queryByRole('alert')).toBeNull();
    const disclosures = transcript.getAllByText(summary);
    expect(disclosures.every((element) => element.tagName === 'SUMMARY')).toBe(true);
    expect(document.activeElement).toBe(disclosures[1]);
    expect(transcript.container.textContent).toContain('[redacted]');
    expect(transcript.container.textContent).not.toContain('example-secret');

    transcript.unmount();
    const remounted = render(CodeTranscript, { messages: [previous, current], chatId });
    expect(remounted.queryByRole('alert')).toBeNull();
    const next = failedTurn('next');
    run.assistantMessageId = next.id;
    await remounted.rerender({ messages: [previous, current, next], chatId });
    expect(remounted.getByRole('alert').textContent).toContain(summary);
  });
});

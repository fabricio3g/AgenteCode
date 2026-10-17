// @vitest-environment jsdom
/**
 * Store-level regressions for the Code space's stuck states. The agente IPC is
 * replaced by a scripted bridge so send/steer/followUp and pushed events can be
 * driven deterministically.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodeAgentEvent } from '$shared/agente-protocol';
import type { ChatSession } from '$lib/types/chat';

const bridge = vi.hoisted(() => ({
  handlers: [] as Array<(payload: unknown) => void>,
  invokes: [] as Array<{ command: string; args?: Record<string, unknown> }>,
  responses: {} as Record<string, unknown>
}));

vi.mock('$lib/services/bridge', () => ({
  isElectron: () => true,
  invoke: async (command: string, args?: Record<string, unknown>) => {
    bridge.invokes.push({ command, args });
    const response = bridge.responses[command];
    return typeof response === 'function' ? (response as (innerArgs?: unknown) => unknown)(args) : response;
  },
  listen: async (_channel: string, handler: (payload: unknown) => void) => {
    bridge.handlers.push(handler);
    return () => {};
  }
}));

import { appStore } from '$lib/stores/app.svelte';
import { codeStore } from './code.svelte';
import { conversationTodos } from './code-run';
import { approvalsStore } from '$lib/stores/approvals.svelte';

const CHAT_ID = 'chat-1';
const PROJECT_ID = 'proj-1';

function makeChat(): ChatSession {
  return {
    id: CHAT_ID,
    title: 'Test conversation',
    createdAt: 1,
    updatedAt: 1,
    folderId: null,
    draft: '',
    contextMode: 'code',
    projectId: PROJECT_ID,
    messages: [],
    codeAgent: {
      instanceId: 'agente',
      driverKind: 'agente',
      substrate: 'native',
      runtimeMode: 'supervised',
      updatedAt: 1
    }
  };
}

function emit(event: CodeAgentEvent): void {
  for (const handler of [...bridge.handlers]) handler(event);
}

/** Kick off a run through send(), which also wires the event subscription. */
async function startRun(): Promise<void> {
  await codeStore.send(CHAT_ID, 'hello');
  expect(codeStore.runFor(CHAT_ID)?.running).toBe(true);
}

beforeEach(() => {
  codeStore.evictChat(CHAT_ID, { force: true });
  codeStore.runs = {};
  codeStore.projects = [{ id: PROJECT_ID, rootPath: '/tmp/proj', rootName: 'proj', createdAt: 1, updatedAt: 1 }];
  appStore.chats = [makeChat()];
  bridge.invokes.length = 0;
  bridge.responses = {
    agente_start_session: { sessionId: 'session-1', resumed: false },
    agente_prompt: { ok: true },
    agente_steer: { ok: true },
    agente_follow_up: { ok: true },
    agente_abort: { ok: true }
  };
  // The real loadAppConfig path falls back to localStorage when the Electron
  // bridge is unavailable, and #resolveProviderModel needs a provider + model.
  localStorage.setItem(
    'chatealm_app_config',
    JSON.stringify({ llm: { provider: 'openai', providers: { openai: { model: 'gpt-4' } } } })
  );
});

describe('queued input accounting', () => {
  it('keeps steering pending until Rust consumes it at a step boundary', async () => {
    await startRun();
    await codeStore.steer(CHAT_ID, 'after the tool');
    emit({ type: 'runtime_event', chatId: CHAT_ID, event: { type: 'steering_queued' } });
    expect(codeStore.runFor(CHAT_ID)?.queuedCount).toBe(1);
    emit({ type: 'runtime_event', chatId: CHAT_ID, event: { type: 'user_messages_injected', messages: ['after the tool'] } });
    expect(codeStore.runFor(CHAT_ID)?.queuedCount).toBe(0);
  });
  it('rolls back the queued count when a steer is rejected', async () => {
    await startRun();
    bridge.responses['agente_steer'] = { ok: false };

    await codeStore.steer(CHAT_ID, 'actually, stop');

    expect(codeStore.runFor(CHAT_ID)?.queuedCount).toBe(0);
  });

  it('rolls back the queued count when the steer IPC throws', async () => {
    await startRun();
    bridge.responses['agente_steer'] = () => {
      throw new Error('ipc down');
    };

    await codeStore.steer(CHAT_ID, 'hello?');

    expect(codeStore.runFor(CHAT_ID)?.queuedCount).toBe(0);
  });

  it('keeps the count when the steer is accepted', async () => {
    await startRun();

    await codeStore.steer(CHAT_ID, 'keep going');

    expect(codeStore.runFor(CHAT_ID)?.queuedCount).toBe(1);
  });

  it('rolls back the queued count when a follow-up is rejected', async () => {
    await startRun();
    bridge.responses['agente_follow_up'] = { ok: false };

    await codeStore.followUp(CHAT_ID, 'then do this');

    expect(codeStore.runFor(CHAT_ID)?.queuedCount).toBe(0);
  });
});

describe('conversation todos', () => {
  const todos = [
    { content: 'Read files', status: 'completed' as const },
    { content: 'Implement change', status: 'in_progress' as const }
  ];

  it('keeps unfinished tasks across Stop and a new prompt until the agent updates them', async () => {
    await startRun();
    emit({ type: 'todo_update', chatId: CHAT_ID, todos });
    await codeStore.stop(CHAT_ID);
    expect(codeStore.runFor(CHAT_ID)?.stopping).toBe(true);
    emit({ type: 'agent_end', chatId: CHAT_ID, stopReason: 'aborted' });
    await codeStore.send(CHAT_ID, 'Continue');
    const run = codeStore.runFor(CHAT_ID)!;
    expect(run.todos).toEqual(todos);
    expect(run.todosUpdated).toBe(false);
    emit({ type: 'todo_update', chatId: CHAT_ID, todos });
    expect(run.todosUpdated).toBe(true);
    emit({ type: 'agent_end', chatId: CHAT_ID, stopReason: 'stop' });
    await codeStore.send(CHAT_ID, 'A question without a todo update');
    emit({ type: 'agent_end', chatId: CHAT_ID, stopReason: 'stop' });
    expect(conversationTodos(appStore.chats[0].messages)).toEqual(todos);
  });

  it('persists live updates and restores them after the run cache is lost', async () => {
    await startRun();
    emit({ type: 'todo_update', chatId: CHAT_ID, todos });
    expect(appStore.chats[0].messages.at(-1)?.metadata?.codeTodos).toEqual(todos);
    emit({ type: 'agent_end', chatId: CHAT_ID, stopReason: 'aborted' });
    codeStore.evictChat(CHAT_ID, { force: true });
    await codeStore.send(CHAT_ID, 'Continue after reload');
    expect(codeStore.runFor(CHAT_ID)?.todos).toEqual(todos);
  });

  it('lets the agent clear or replace the list without resurrecting older tasks', async () => {
    await startRun();
    emit({ type: 'todo_update', chatId: CHAT_ID, todos });
    emit({ type: 'agent_end', chatId: CHAT_ID, stopReason: 'aborted' });
    await codeStore.send(CHAT_ID, 'Do something else');
    const replacement = [{ content: 'New task', status: 'pending' as const }];
    emit({ type: 'todo_update', chatId: CHAT_ID, todos: replacement });
    expect(codeStore.runFor(CHAT_ID)?.todos).toEqual(replacement);
    emit({ type: 'todo_update', chatId: CHAT_ID, todos: [] });
    emit({ type: 'agent_end', chatId: CHAT_ID, stopReason: 'stop' });
    expect(appStore.chats[0].messages.at(-1)?.metadata?.codeTodos).toEqual([]);
    codeStore.evictChat(CHAT_ID, { force: true });
    await codeStore.send(CHAT_ID, 'Next task');
    expect(codeStore.runFor(CHAT_ID)?.todos).toEqual([]);
  });

  it('carries tasks into a queued follow-up and retains older legacy snapshots', async () => {
    await startRun();
    emit({ type: 'todo_update', chatId: CHAT_ID, todos });
    await codeStore.followUp(CHAT_ID, 'Then verify');
    emit({ type: 'agent_end', chatId: CHAT_ID, stopReason: 'stop' });
    emit({ type: 'agent_start', chatId: CHAT_ID });
    expect(codeStore.runFor(CHAT_ID)?.todos).toEqual(todos);
    expect(codeStore.runFor(CHAT_ID)?.todosUpdated).toBe(false);
    emit({ type: 'agent_end', chatId: CHAT_ID, stopReason: 'aborted' });
    delete appStore.chats[0].messages.at(-1)!.metadata!.codeTodos;
    expect(conversationTodos(appStore.chats[0].messages)).toEqual(todos);
  });
});

describe('run finalization', () => {
  it('finalizes the streaming placeholder when an error ends the run', async () => {
    await startRun();

    emit({ type: 'error', chatId: CHAT_ID, message: 'provider unreachable' });

    const run = codeStore.runFor(CHAT_ID)!;
    expect(run.done).toBe(true);
    expect(run.running).toBe(false);

    const message = appStore.chats[0]!.messages.at(-1)!;
    expect(message.status).toBe('error');
    expect(message.done).toBe(true);
    expect((message.metadata as Record<string, unknown>)?.errorMessage).toBe('provider unreachable');
  });

  it.each(['rejected', 'thrown'])('finalizes the streaming placeholder when the prompt IPC is %s', async (failure) => {
    await startRun();
    emit({ type: 'agent_end', chatId: CHAT_ID, stopReason: 'stop' });

    bridge.responses['agente_prompt'] = failure === 'thrown'
      ? () => { throw new Error('prompt ipc down'); }
      : { ok: false, error: 'prompt ipc down' };
    await codeStore.send(CHAT_ID, 'second prompt while idle');

    const run = codeStore.runFor(CHAT_ID)!;
    expect(run.done).toBe(true);
    expect(run.running).toBe(false);
    expect(run.error).toBe('prompt ipc down');

    const message = appStore.chats[0]!.messages.at(-1)!;
    expect(message.status).toBe('error');
    expect((message.metadata as Record<string, unknown>)?.errorMessage).toBe('prompt ipc down');
  });
});

/** Mid-stream deltas reach the message once per frame (structural events flush at once). */
const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('streaming targets the last assistant message, not the transcript tail', () => {
  it('a steer waits in the panel, not the thread, while the reply keeps streaming', async () => {
    await startRun();

    emit({ type: 'text_delta', chatId: CHAT_ID, delta: 'first' });
    await codeStore.steer(CHAT_ID, 'course correction');
    emit({ type: 'text_delta', chatId: CHAT_ID, delta: ' after steer' });
    await nextFrame();

    const chat = appStore.chats[0]!;
    expect(chat.messages).toHaveLength(2);
    expect(chat.pendingPrompts?.map((item) => [item.content, item.sending])).toEqual([['course correction', true]]);
    const assistant = chat.messages[1]!;
    expect(assistant.status).toBe('streaming');
    expect(assistant.content).toBe('first after steer');
  });

  it('a steer the model takes sits between the reply before it and the reply after it', async () => {
    await startRun();

    emit({ type: 'text_delta', chatId: CHAT_ID, delta: 'before' });
    await codeStore.steer(CHAT_ID, 'course correction');
    emit({ type: 'text_delta', chatId: CHAT_ID, delta: ' still before' });
    emit({ type: 'runtime_event', chatId: CHAT_ID, event: { type: 'user_messages_injected', messages: ['course correction'] } });
    emit({ type: 'text_delta', chatId: CHAT_ID, delta: 'after' });
    emit({ type: 'agent_end', chatId: CHAT_ID, stopReason: 'stop' });

    const chat = appStore.chats[0]!;
    expect(chat.messages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'hello'],
      ['assistant', 'before still before'],
      ['user', 'course correction'],
      ['assistant', 'after']
    ]);
    expect(chat.messages[1]!.done).toBeFalsy();
    expect(chat.messages[3]!.done).toBe(true);
    expect(chat.pendingPrompts ?? []).toEqual([]);
  });

  it('a steer the turn never read goes back to the panel, editable, and the reply finalizes', async () => {
    await startRun();

    await codeStore.steer(CHAT_ID, 'steer after start');
    emit({ type: 'thinking_delta', chatId: CHAT_ID, delta: 'thinking' });
    emit({ type: 'text_delta', chatId: CHAT_ID, delta: 'answer' });
    emit({ type: 'agent_end', chatId: CHAT_ID, stopReason: 'aborted' });

    const chat = appStore.chats[0]!;
    expect(chat.messages).toHaveLength(2);
    expect(chat.pendingPrompts?.map((item) => [item.content, !!item.sending])).toEqual([['steer after start', false]]);
    const assistant = chat.messages[1]!;
    expect(assistant.status).toBe('idle');
    expect(assistant.done).toBe(true);
    expect(assistant.content).toBe('answer');
    expect(assistant.reasoning).toBe('thinking');
  });

  it('a steer read as the turn closes gets its empty reply removed and an answer asked for', async () => {
    await startRun();

    emit({ type: 'text_delta', chatId: CHAT_ID, delta: 'done' });
    await codeStore.steer(CHAT_ID, 'one more thing');
    emit({ type: 'runtime_event', chatId: CHAT_ID, event: { type: 'user_messages_injected', messages: ['one more thing'] } });
    emit({ type: 'agent_end', chatId: CHAT_ID, stopReason: 'stop' });

    const chat = appStore.chats[0]!;
    expect(chat.messages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'hello'],
      ['assistant', 'done'],
      ['user', 'one more thing']
    ]);
    await nextFrame();
    expect(bridge.invokes.some((call) => call.command === 'agente_prompt' && (call.args as { text?: string })?.text === 'Continue')).toBe(true);
  });

  it('a follow-up lands in the transcript and finalization reaches the original assistant message', async () => {
    await startRun();

    await codeStore.followUp(CHAT_ID, 'queued follow-up');
    emit({ type: 'text_delta', chatId: CHAT_ID, delta: 'queued' });
    emit({ type: 'agent_end', chatId: CHAT_ID, stopReason: 'stop' });

    const messages = appStore.chats[0]!.messages;
    expect(messages).toHaveLength(3);
    const userFollowUp = messages.at(-1)!;
    expect(userFollowUp.role).toBe('user');
    expect(userFollowUp.content).toBe('queued follow-up');

    const assistant = messages[1]!;
    expect(assistant.role).toBe('assistant');
    expect(assistant.status).toBe('idle');
    expect(assistant.done).toBe(true);
    expect(assistant.content).toBe('queued');
  });

  it('a failed steer stays in the panel, editable, and the reply keeps streaming', async () => {
    await startRun();
    bridge.responses['agente_steer'] = { ok: false };
    await codeStore.steer(CHAT_ID, 'lost steer');
    emit({ type: 'text_delta', chatId: CHAT_ID, delta: 'kept' });
    await nextFrame();

    const chat = appStore.chats[0]!;
    expect(chat.messages).toHaveLength(2);
    expect(chat.pendingPrompts?.map((item) => [item.content, !!item.sending])).toEqual([['lost steer', false]]);
    const assistant = chat.messages[1]!;
    expect(assistant.status).toBe('streaming');
    expect(assistant.content).toBe('kept');
  });
});

describe('stable assistant targeting across run restarts', () => {
  it('gives an automatically started follow-up its own streaming reply', async () => {
    await startRun();
    emit({ type: 'text_delta', chatId: CHAT_ID, delta: 'first reply' });
    await codeStore.followUp(CHAT_ID, 'next task');
    emit({ type: 'agent_end', chatId: CHAT_ID, stopReason: 'stop' });
    emit({ type: 'agent_start', chatId: CHAT_ID });
    emit({ type: 'text_delta', chatId: CHAT_ID, delta: 'second reply' });
    emit({ type: 'agent_end', chatId: CHAT_ID, stopReason: 'stop' });
    const messages = appStore.chats[0]!.messages;
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(messages[1]!.content).toBe('first reply');
    expect(messages[3]!.content).toBe('second reply');
    expect(messages[3]!.status).toBe('idle');
  });
  it('a run started after eviction binds to the fresh assistant message and finalizes it', async () => {
    await startRun();
    emit({ type: 'agent_end', chatId: CHAT_ID, stopReason: 'stop' });

    codeStore.evictChat(CHAT_ID); // project removal evicts idle runs
    await codeStore.send(CHAT_ID, 'turn after eviction');

    emit({ type: 'text_delta', chatId: CHAT_ID, delta: 'fresh' });
    emit({ type: 'agent_end', chatId: CHAT_ID, stopReason: 'stop' });

    const messages = appStore.chats[0]!.messages;
    expect(messages).toHaveLength(4);
    const first = messages[1]!;
    expect(first.status).toBe('idle');
    const second = messages[3]!;
    expect(second.role).toBe('assistant');
    expect(second.status).toBe('idle');
    expect(second.done).toBe(true);
    expect(second.content).toBe('fresh');
  });

  it('a run re-materialized after reload binds to the latest streaming assistant message', async () => {
    await startRun();
    emit({ type: 'agent_end', chatId: CHAT_ID, stopReason: 'stop' });

    codeStore.runs = {}; // fresh renderer mid-conversation
    await codeStore.send(CHAT_ID, 'turn after reload');
    emit({ type: 'text_delta', chatId: CHAT_ID, delta: 'after reload' });
    emit({ type: 'agent_end', chatId: CHAT_ID, stopReason: 'stop' });

    const messages = appStore.chats[0]!.messages;
    expect(messages).toHaveLength(4);
    const first = messages[1]!;
    expect(first.status).toBe('idle');
    const second = messages[3]!;
    expect(second.status).toBe('idle');
    expect(second.done).toBe(true);
    expect(second.content).toBe('after reload');
  });
});

describe('event delivery after a reload', () => {
  it('materializes a run when the first event arrives without run state', async () => {
    await startRun();
    codeStore.runs = {}; // fresh renderer: the chat exists, its run map is empty

    emit({ type: 'text_delta', chatId: CHAT_ID, delta: 'reconnected' });

    expect(codeStore.runFor(CHAT_ID)?.content).toBe('reconnected');
  });

  it('ignores events for chats that no longer exist', () => {
    emit({ type: 'text_delta', chatId: 'ghost-chat', delta: 'x' });

    expect(codeStore.runFor('ghost-chat')).toBeNull();
  });
});

describe('run eviction', () => {
  it('evicts cached run and session state when the chat is deleted', async () => {
    await startRun();
    expect(codeStore.hasSession(CHAT_ID)).toBe(true);

    appStore.deleteChat(CHAT_ID);

    expect(codeStore.runFor(CHAT_ID)).toBeNull();
    expect(codeStore.hasSession(CHAT_ID)).toBe(false);
  });

  it('deleting a project aborts its runs and deletes its conversations and engine data', async () => {
    await startRun();
    bridge.responses['agente_delete_session_data'] = { ok: true, removed: 1 };

    await codeStore.deleteProject(PROJECT_ID);

    expect(bridge.invokes.some((call) => call.command === 'agente_abort' && call.args?.chatId === CHAT_ID)).toBe(true);
    expect(appStore.chats.some((chat) => chat.id === CHAT_ID)).toBe(false);
    expect(codeStore.runFor(CHAT_ID)).toBeNull();
    const cleanup = bridge.invokes.find((call) => call.command === 'agente_delete_session_data');
    expect(cleanup?.args).toEqual({ chatIds: [CHAT_ID], sessionIds: ['session-1'] });
  });

  it('lists conversations whose project is gone as unlinked', () => {
    codeStore.loaded = true;
    codeStore.projects = [];
    expect(codeStore.unlinkedConversations.map((chat) => chat.id)).toEqual([CHAT_ID]);
  });
});

describe('approvals and interrupted runs', () => {
  it('drops approval buttons the engine settled itself (Stop) without answering again', async () => {
    await startRun();
    emit({ type: 'approval_request', chatId: CHAT_ID, requestId: 'apr-9', toolName: 'edit', args: { path: 'a.ts' } });
    expect(approvalsStore.forChat(CHAT_ID)).toHaveLength(1);

    emit({ type: 'approval_resolved', chatId: CHAT_ID, requestId: 'apr-9', decision: 'deny' });
    await Promise.resolve();
    await Promise.resolve();

    expect(approvalsStore.forChat(CHAT_ID)).toHaveLength(0);
    expect(bridge.invokes.some((call) => call.command === 'agente_respond_approval')).toBe(false);
  });

  it('clears pending approvals when the run ends', async () => {
    await startRun();
    emit({ type: 'approval_request', chatId: CHAT_ID, requestId: 'apr-10', toolName: 'bash', args: { command: 'ls' } });
    emit({ type: 'agent_end', chatId: CHAT_ID, stopReason: 'aborted' });
    expect(approvalsStore.forChat(CHAT_ID)).toHaveLength(0);
  });
});


describe('editable prompt queue', () => {
  it('keeps prompts out of the transcript and IPC until explicit send-now', async () => {
    await startRun();
    codeStore.queue(CHAT_ID, 'first');
    codeStore.queue(CHAT_ID, 'second');
    const chat = appStore.chats[0]!;
    expect(chat.messages).toHaveLength(2);
    expect(bridge.invokes.filter(call => call.command === 'agente_steer')).toHaveLength(0);
    const first = chat.pendingPrompts![0]!;
    const second = chat.pendingPrompts![1]!;
    appStore.updateQueuedPrompt(CHAT_ID, first.id, 'revised first');
    appStore.removeQueuedPrompt(CHAT_ID, second.id);
    expect(chat.pendingPrompts?.map(item => item.content)).toEqual(['revised first']);
    await codeStore.sendQueuedNow(CHAT_ID);
    expect(chat.messages).toHaveLength(2);
    expect(chat.pendingPrompts![0]?.sending).toBe(true);
    expect(bridge.invokes.find(call => call.command === 'agente_steer')?.args?.text).toBe('revised first');
    emit({ type: 'runtime_event', chatId: CHAT_ID, event: { type: 'user_messages_injected', messages: ['revised first'] } });
    expect(chat.pendingPrompts).toEqual([]);
    expect(chat.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['hello', 'revised first']);
  });

  it('does not double-send and unlocks a rejected prompt for editing', async () => {
    await startRun();
    codeStore.queue(CHAT_ID, 'retry me');
    let resolve!: (value: unknown) => void;
    bridge.responses.agente_steer = () => new Promise(done => { resolve = done; });
    const send = codeStore.sendQueuedNow(CHAT_ID);
    await Promise.resolve();
    await codeStore.sendQueuedNow(CHAT_ID);
    expect(bridge.invokes.filter(call => call.command === 'agente_steer')).toHaveLength(1);
    resolve({ ok: false }); await send;
    const chat = appStore.chats[0]!;
    expect(chat.pendingPrompts![0]?.sending).toBe(false);
    expect(chat.messages).toHaveLength(2);
  });

  it('retains a stopped queue and keeps another conversation isolated', async () => {
    await startRun();
    const other: ChatSession = { ...makeChat(), id: 'other', pendingPrompts: [] };
    appStore.chats.push(other);
    codeStore.queue(CHAT_ID, 'continue later');
    codeStore.queue('other', 'other task');
    emit({ type: 'agent_end', chatId: CHAT_ID, stopReason: 'aborted' });
    expect(appStore.chats[0]?.pendingPrompts?.[0]?.content).toBe('continue later');
    expect(appStore.chats.find(chat => chat.id === 'other')?.pendingPrompts?.[0]?.content).toBe('other task');
  });
});

describe('manual compaction reporting', () => {
  it('adds a separate idle report without modifying an old answer', async () => {
    await startRun();
    emit({ type: 'text_delta', chatId: CHAT_ID, delta: 'Original answer' });
    emit({ type: 'agent_end', chatId: CHAT_ID, stopReason: 'stop' });
    const before = appStore.chats[0]!.messages[1]!.content;
    emit({ type: 'compaction_start', chatId: CHAT_ID, reason: 'manual' });
    expect(appStore.chats[0]!.messages.at(-1)!.metadata?.codeCompaction?.running).toBe(true);
    emit({ type: 'compaction_end', chatId: CHAT_ID, reason: 'manual', success: true, tokensBefore: 12000, tokensAfter: 4000, smart: true, summary: "Keep the selected model and pending edits.", requestedSmart: true, modelTokens: 800 });
    const report = appStore.chats[0]!.messages.at(-1)!.metadata!.codeCompaction!;
    expect(report).toMatchObject({ running: false, tokensBefore: 12000, tokensAfter: 4000, smart: true, summary: "Keep the selected model and pending edits.", modelTokens: 800 });
    expect(appStore.chats[0]!.messages[1]!.content).toBe(before);
  });

  it('settles no-change and failed reports visibly', async () => {
    emit({ type: 'compaction_start', chatId: CHAT_ID, reason: 'manual' });
    emit({ type: 'compaction_end', chatId: CHAT_ID, reason: 'manual', success: true, tokensBefore: 120, tokensAfter: 120 });
    expect(appStore.chats[0]!.messages.at(-1)!.metadata?.codeCompaction).toMatchObject({ running: false, tokensBefore: 120, tokensAfter: 120 });
    emit({ type: 'compaction_start', chatId: CHAT_ID, reason: 'manual' });
    emit({ type: 'compaction_end', chatId: CHAT_ID, reason: 'manual', success: false });
    expect(appStore.chats[0]!.messages.at(-1)!.metadata?.codeCompaction).toMatchObject({ running: false, success: false });
  });
});

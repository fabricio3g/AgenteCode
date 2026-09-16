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

describe('streaming targets the last assistant message, not the transcript tail', () => {
  it('steers land in the original assistant message, not the appended user turn', async () => {
    await startRun();

    emit({ type: 'text_delta', chatId: CHAT_ID, delta: 'first' });
    await codeStore.steer(CHAT_ID, 'course correction');
    emit({ type: 'text_delta', chatId: CHAT_ID, delta: ' after steer' });

    const messages = appStore.chats[0]!.messages;
    expect(messages).toHaveLength(3);
    const userSteer = messages.at(-1)!;
    expect(userSteer.role).toBe('user');
    expect(userSteer.content).toBe('course correction');
    expect(userSteer.status).toBeUndefined();

    const assistant = messages[1]!;
    expect(assistant.role).toBe('assistant');
    expect(assistant.status).toBe('streaming');
    expect(assistant.content).toBe('first after steer');
  });

  it('a steer carrying reasoning deltas finalizes the original assistant message', async () => {
    await startRun();

    await codeStore.steer(CHAT_ID, 'steer after start');
    emit({ type: 'thinking_delta', chatId: CHAT_ID, delta: 'thinking' });
    emit({ type: 'text_delta', chatId: CHAT_ID, delta: 'answer' });
    emit({ type: 'agent_end', chatId: CHAT_ID, stopReason: 'stop' });

    const messages = appStore.chats[0]!.messages;
    const userSteer = messages.at(-1)!;
    expect(userSteer.role).toBe('user');
    expect(userSteer.content).toBe('steer after start');

    const assistant = messages[1]!;
    expect(assistant.status).toBe('idle');
    expect(assistant.done).toBe(true);
    expect(assistant.content).toBe('answer');
    expect(assistant.reasoning).toBe('thinking');
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

  it('a failed steer keeps the transcript intact and streaming into the assistant message', async () => {
    await startRun();
    bridge.responses['agente_steer'] = { ok: false };
    await codeStore.steer(CHAT_ID, 'lost steer');
    emit({ type: 'text_delta', chatId: CHAT_ID, delta: 'kept' });

    const messages = appStore.chats[0]!.messages;
    expect(messages).toHaveLength(3);
    expect(messages.at(-1)!.role).toBe('user');
    const assistant = messages[1]!;
    expect(assistant.status).toBe('streaming');
    expect(assistant.content).toBe('kept');
  });
});

describe('stable assistant targeting across run restarts', () => {
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

  it('evicts finished runs but keeps live ones for chats of a removed project', async () => {
    await startRun();

    // A live run is still streaming into its transcript — leave it alone.
    await codeStore.removeProject(PROJECT_ID);
    expect(codeStore.runFor(CHAT_ID)).not.toBeNull();

    emit({ type: 'agent_end', chatId: CHAT_ID, stopReason: 'stop' });
    await codeStore.removeProject(PROJECT_ID);
    expect(codeStore.runFor(CHAT_ID)).toBeNull();
  });
});

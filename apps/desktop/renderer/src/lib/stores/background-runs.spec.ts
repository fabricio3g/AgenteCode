// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunAgentTaskArgs, AgentTaskResult } from '$lib/services/agent-types';
import type { ChatSession } from '$lib/types/chat';

const runtime = vi.hoisted(() => ({ pending: new Map<string, { args: RunAgentTaskArgs; finish: (result: AgentTaskResult) => void }>() }));
vi.mock('$lib/services/agent', () => ({ runAgentTask: vi.fn((args: RunAgentTaskArgs) => new Promise(resolve => runtime.pending.set(args.chatId, { args, finish: resolve }))) }));
vi.mock('$lib/services/agent-design-runtime', () => ({ captureDesignTurnContext: () => ({ selection: 'hero', references: [] }), runDesignTask: vi.fn((args: RunAgentTaskArgs) => new Promise(resolve => runtime.pending.set(args.chatId, { args, finish: resolve }))) }));
vi.mock('$lib/utils/storage', async original => ({ ...await original<typeof import('$lib/utils/storage')>(), saveChatState: vi.fn(), saveChatStateToDb: vi.fn().mockResolvedValue(undefined) }));
import { appStore } from './app.svelte';

beforeEach(() => {
  runtime.pending.clear();
  appStore.activeRunsByChat = {};
  appStore.config = { llm: { backend_mode: 'api', provider: 'opencode-go', providers: { 'opencode-go': { model: 'deepseek-v4.1-flash', base_url: 'https://opencode.ai/zen/go/v1', has_api_key: true } } } };
  appStore.chats = ['home', 'design', 'code'].map(id => ({ id, title: id, contextMode: id, composerMode: 'agent', searchMode: 'chat', createdAt: 1, updatedAt: 1, folderId: null, draft: '', messages: [] } as ChatSession));
  vi.spyOn(appStore, 'refreshModels').mockResolvedValue(undefined);
  vi.spyOn(appStore, 'refreshReasoningCapabilities').mockResolvedValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); appStore.activeRunsByChat = {}; });

describe('background agents across spaces', () => {
  it('continues Home and Design while Code is open and saves both replies to their owners', async () => {
    const sends: Promise<void>[] = [];
    for (const id of ['home', 'design']) {
      appStore.selectChat(id);
      appStore.composer = `Build something for ${id}`;
      sends.push(appStore.sendCurrentMessage());
      await vi.waitFor(() => expect(runtime.pending.has(id)).toBe(true));
    }
    appStore.selectChat('code');
    expect(appStore.currentRun).toBeNull();
    expect(appStore.hasAnyGeneration).toBe(true);
    for (const id of ['home', 'design']) {
      const { args, finish } = runtime.pending.get(id)!;
      expect(args.signal?.aborted).toBe(false);
      args.onContent?.(`${id} kept working`);
      finish({ content: `${id} finished`, reasoning: '', steps: [], artifact: null, artifacts: [], sources: [], outcome: 'completed', stopReason: 'none' });
    }
    await Promise.all(sends);
    expect(appStore.currentChatId).toBe('code');
    expect(appStore.hasAnyGeneration).toBe(false);
    for (const id of ['home', 'design']) expect(appStore.findChat(id)?.messages.at(-1)).toMatchObject({ content: `${id} finished`, done: true });
    expect(appStore.findChat('code')?.messages).toEqual([]);
  });
});

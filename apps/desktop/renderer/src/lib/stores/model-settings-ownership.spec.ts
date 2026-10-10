// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('$lib/services/bridge', async original => ({ ...await original<typeof import('$lib/services/bridge')>(), isElectron: () => true }));
vi.mock('$lib/utils/storage', async original => ({ ...await original<typeof import('$lib/utils/storage')>(), saveAppConfig: vi.fn(), saveChatState: vi.fn(), saveChatStateToDb: vi.fn() }));
vi.mock('$lib/services/chat-api', async original => ({ ...await original<typeof import('$lib/services/chat-api')>(), detectToolSupport: vi.fn().mockResolvedValue(true) }));
import { appStore } from './app.svelte';
import { captureChatModel } from './chat-model';
import { saveAppConfig } from '$lib/utils/storage';
import { detectToolSupport } from '$lib/services/chat-api';
import type { AppConfig, ChatSession } from '$lib/types/chat';
const config = (model: string): AppConfig => ({ llm: { backend_mode: 'api', provider: 'openrouter', providers: { openrouter: { base_url: 'https://openrouter.ai/api/v1', model } } } });
beforeEach(() => {
  vi.clearAllMocks(); vi.mocked(detectToolSupport).mockResolvedValue(true); appStore.config = config('first');
  appStore.chats = ['one', 'two'].map((id, index) => ({ id, title: id, createdAt: 1, updatedAt: 1, contextMode: 'home', folderId: null, draft: '', messages: [], modelSelection: captureChatModel(config(index ? 'second' : 'first')) } satisfies ChatSession));
  appStore.currentChatId = 'one';
  vi.spyOn(appStore, 'persist').mockImplementation(() => {});
  vi.spyOn(appStore, 'refreshModels').mockResolvedValue(undefined);
  vi.spyOn(appStore, 'refreshReasoningCapabilities').mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('settings facade preserves conversation ownership', () => {
  it('pins the original conversation before async persistence even if the visible chat changes', async () => {
    let release!: () => void; vi.mocked(saveAppConfig).mockReturnValueOnce(new Promise<void>(resolve => { release = resolve; }));
    const update = appStore.updateProvider({ provider: 'openrouter', model: 'chosen' });
    expect(appStore.chats[0].modelSelection?.model).toBe('chosen');
    appStore.currentChatId = 'two'; release(); await update;
    expect(appStore.chats[0].modelSelection?.model).toBe('chosen'); expect(appStore.chats[1].modelSelection?.model).toBe('second'); expect(appStore.config.llm?.providers?.openrouter.model).toBe('second');
  });
  it('passes credentials to persistence and removes renderer-held keys after saving', async () => {
    let saved: AppConfig | undefined;
    vi.mocked(saveAppConfig).mockImplementationOnce(async next => { saved = JSON.parse(JSON.stringify(next)); });
    await appStore.updateProvider({ provider: 'openrouter', api_key: 'test-only-key' });
    expect(saved?.llm?.providers?.openrouter.api_key).toBe('test-only-key');
    expect(appStore.config.llm?.providers?.openrouter.api_key).toBeUndefined(); expect(appStore.config.llm?.providers?.openrouter.has_api_key).toBe(true);
  });
});

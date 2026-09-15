import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/utils/storage', () => ({ loadAppConfig: vi.fn(async () => ({ llm: { backend_mode: 'api', provider: 'gemini', providers: { gemini: { model: 'gemini-3-flash', base_url: 'https://example.test' } } } })) }));
vi.mock('$lib/services/bridge', () => ({ isElectron: () => true, invoke: vi.fn(), listen: vi.fn() }));
vi.mock('$lib/services/agent-token-budget', () => ({ enforceTokenBudget: vi.fn(async () => {}) }));
vi.mock('$lib/services/agent-llm', () => ({ supportsNativeTools: vi.fn(() => true), agentComplete: vi.fn(), agentStreamComplete: vi.fn() }));
vi.mock('$lib/services/live-data', () => ({ liveGeocodePlace: vi.fn(async () => ({ latitude: -34.6037, longitude: -58.3816, label: 'Buenos Aires, Argentina' })) }));

import { agentStreamComplete, supportsNativeTools } from './agent-llm';
import { liveGeocodePlace } from './live-data';
import { loadAppConfig } from '$lib/utils/storage';
import { buildMessageParts, isAssistantMessageEmpty } from '$lib/features/chat/thread/message-parts';
import type { ChatMessage } from '$lib/types/chat';
import { runAgentTask } from './agent';
import { resolveArtifactPreview } from './artifact-model';
import { shouldUseToolLoop } from './composer-route';

describe('Home agent tool round trip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(agentStreamComplete).mockReset();
    vi.mocked(supportsNativeTools).mockReturnValue(true);
  });

  it.each(['native', 'xml', 'attributes', 'native-rejected'] as const)('publishes a visible map through the %s path', async (mode) => {
    if (mode === 'xml' || mode === 'attributes') {
      vi.mocked(supportsNativeTools).mockReturnValue(false);
      vi.mocked(loadAppConfig).mockResolvedValueOnce({ llm: { backend_mode: 'local', local: { model: 'llama.cpp' } } });
    }
    if (mode === 'native-rejected') {
      vi.mocked(agentStreamComplete).mockImplementationOnce(async (args) => {
        args.onError?.('Tools are not supported by this model');
        return null;
      });
    }
    const tag = mode === 'attributes'
      ? `<tool_call id="1" label="maps" parameters='{"center":"Buenos Aires, Argentina","zoom":12,"size":"800x600","maptype":"roadmap"}'></tool_call>`
      : '<tool_call>{"name":"create_map","arguments":{"place":"Buenos Aires, Argentina","zoom":12}}</tool_call>';
    const requests: Parameters<typeof agentStreamComplete>[0][] = [];
    vi.mocked(agentStreamComplete).mockImplementationOnce(async (args) => {
      requests.push(structuredClone({ messages: args.messages, tools: args.tools }));
      if (mode === 'native') return { content: '', reasoning: '', toolCalls: [{ id: 'map-1', name: 'create_map', arguments: { place: 'Buenos Aires, Argentina', zoom: 12 } }] };
      for (let i = 0; i < tag.length; i += 7) args.onContent?.(tag.slice(i, i + 7));
      return { content: tag, reasoning: '' };
    }).mockImplementationOnce(async (args) => {
      requests.push(structuredClone({ messages: args.messages, tools: args.tools }));
      args.onContent?.('Here is Buenos Aires.');
      return { content: 'Here is Buenos Aires.', reasoning: '' };
    });
    const onArtifact = vi.fn();
    const onContent = vi.fn();
    const onStep = vi.fn();
    const result = await runAgentTask({ chatId: 'home-map', rawPrompt: 'Show me a map of Buenos Aires', messages: [{ role: 'user', content: 'Show me a map of Buenos Aires' }], agentProfile: 'chat', maxIterations: 6, onArtifact, onContent, onStep });
    expect(result.stopReason).toBe('none');
    expect(result.artifact?.inline).toMatchObject({ kind: 'map', latitude: -34.6037, longitude: -58.3816, zoom: 12 });
    expect(onArtifact).toHaveBeenLastCalledWith(result.artifacts);
    expect(liveGeocodePlace).toHaveBeenCalledWith('Buenos Aires, Argentina');
    expect(JSON.stringify(onContent.mock.calls)).not.toContain('tool_call');
    expect(JSON.stringify(onStep.mock.calls)).not.toContain('<tool_call');
    expect(requests[1].messages.some((m) => String(m.content).includes('map.json'))).toBe(true);
    if (mode === 'native') expect(requests[1].messages.some((m) => m.tool_call_id === 'map-1')).toBe(true);
    else expect(requests[1].tools).toBeUndefined();
    const message = { id: 'map-message', role: 'assistant', content: '', status: 'idle', artifacts: result.artifacts } as ChatMessage;
    const display = { message, displayContent: '', displayReasoning: '', displayMetadata: null, hasActiveDeepResearch: false };
    expect(isAssistantMessageEmpty(display)).toBe(false);
    expect(buildMessageParts({ ...display, enableThinking: true, hasDocumentArtifact: false, hasPendingApproval: false })).toContainEqual(expect.objectContaining({ kind: 'artifact' }));
  });

  it('publishes a code-block website as a previewable web artifact', async () => {
    const html = '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1>Lumina</h1><script src="script.js"></script></body></html>';
    const website = ['```html', html, '```', '```css', 'body { color: #111; }', '```', '```js', 'console.log("lumina");', '```'].join('\n');
    vi.mocked(agentStreamComplete)
      .mockImplementationOnce(async (args) => {
        args.onContent?.(website);
        return { content: website, reasoning: '' };
      })
      .mockImplementationOnce(async (args) => {
        args.onContent?.('The Lumina site is ready.');
        return { content: 'The Lumina site is ready.', reasoning: '' };
      });
    const onArtifact = vi.fn();
    const result = await runAgentTask({ chatId: 'home-site', rawPrompt: 'Build a website for Lumina', messages: [{ role: 'user', content: 'Build a website for Lumina' }], agentProfile: 'chat', onStep: vi.fn(), onArtifact });

    // The auto-write path writes the files, then preview_project publishes them.
    const sites = result.artifacts.filter((artifact) => artifact.manifest?.kind === 'web');
    expect(sites).toHaveLength(1);
    expect(Object.keys(sites[0]!.files).sort()).toEqual(['index.html', 'script.js', 'style.css']);
    expect(sites[0]!.manifest?.entryPath).toBe('index.html');
    // The entry has to resolve, or the chat card and studio preview stay empty.
    expect(resolveArtifactPreview(sites[0]!)).toMatchObject({ basePath: 'index.html', source: 'manifest' });
    expect(onArtifact).toHaveBeenCalled();
  });

  it('publishes a website even when the model writes files but never previews them', async () => {
    const html = '<!doctype html><html><body><h1>Lumina</h1></body></html>';
    vi.mocked(agentStreamComplete)
      .mockImplementationOnce(async () => ({
        content: '',
        reasoning: '',
        toolCalls: [{ id: 'w1', name: 'write_file', arguments: { path: 'index.html', content: html } }]
      }))
      .mockImplementationOnce(async () => ({ content: 'Wrote the Lumina site.', reasoning: '' }));
    const result = await runAgentTask({ chatId: 'home-site-native', rawPrompt: 'Build a website for Lumina', messages: [{ role: 'user', content: 'Build a website for Lumina' }], agentProfile: 'chat', onStep: vi.fn(), onArtifact: vi.fn() });

    // No preview_project call: the run-end safety net must still publish the site.
    const sites = result.artifacts.filter((artifact) => artifact.manifest?.kind === 'web');
    expect(sites).toHaveLength(1);
    expect(sites[0]!.manifest?.entryPath).toBe('index.html');
    expect(resolveArtifactPreview(sites[0]!)).toMatchObject({ basePath: 'index.html' });
  });

  it('answers ordinary chat in one streamed turn without manufacturing files from code examples', async () => {
    const content = 'Here is an example:\n```js\nconst sum = 2 + 2;\n```';
    vi.mocked(agentStreamComplete).mockResolvedValueOnce({ content, reasoning: '' });
    const onArtifact = vi.fn();
    const result = await runAgentTask({ chatId: 'home-chat', rawPrompt: 'Explain addition in JavaScript', messages: [{ role: 'user', content: 'Explain addition in JavaScript' }], agentProfile: 'chat', onStep: vi.fn(), onArtifact });
    expect(result.content).toBe(content);
    expect(agentStreamComplete).toHaveBeenCalledTimes(1);
    expect(result.artifacts).toHaveLength(0);
  });

  it('retries a missing widget and reports a visible failure on another miss', async () => {
    vi.mocked(agentStreamComplete).mockResolvedValue({ content: 'I can show a map.', reasoning: '' });
    const result = await runAgentTask({ chatId: 'missing-map', rawPrompt: 'Show me a map of Madrid', messages: [{ role: 'user', content: 'Show me a map of Madrid' }], agentProfile: 'chat', onStep: vi.fn(), onArtifact: vi.fn() });
    expect(agentStreamComplete).toHaveBeenCalledTimes(2);
    expect(result.stopReason).toBe('missing_artifacts');
    expect(result.content).toContain('did not create');
    expect(result.artifacts).toHaveLength(0);
  });

  it('honors disabled map settings without repeatedly asking the model for that tool', async () => {
    vi.mocked(loadAppConfig).mockResolvedValueOnce({ llm: { backend_mode: 'api' }, ui: { artifact_toggles: { map: false } } });
    vi.mocked(agentStreamComplete).mockResolvedValueOnce({ content: 'Map widgets are disabled.', reasoning: '' });
    const result = await runAgentTask({ chatId: 'disabled-map', rawPrompt: 'Show me a map of Madrid', messages: [{ role: 'user', content: 'Show me a map of Madrid' }], agentProfile: 'chat', onStep: vi.fn(), onArtifact: vi.fn() });
    expect(agentStreamComplete).toHaveBeenCalledTimes(1);
    expect(vi.mocked(agentStreamComplete).mock.calls[0][0].tools?.some((tool) => tool.function.name === 'create_map')).toBe(false);
    expect(result.artifacts).toHaveLength(0);
    expect(liveGeocodePlace).not.toHaveBeenCalled();
  });
  it('honors the explicit Agent choice even with automatic routing', () => {
    expect(shouldUseToolLoop({ control: 'auto', composerMode: 'agent', route: 'conversation', contextMode: 'home' })).toBe(true);
  });

  it('executes a native tool, replays its signed state, and streams each thought once', async () => {
    const state = { provider: 'gemini', blocks: [{ thoughtSignature: 'signed', functionCall: { name: 'calculator', args: { expression: '2+2' } } }] };
    const requests: unknown[] = [];
    vi.mocked(agentStreamComplete).mockImplementationOnce(async (args) => {
      requests.push(structuredClone(args.messages));
      args.onReasoning?.('Calculate.');
      args.onContent?.('Checking ');
      args.onContent?.('the sum.');
      return { content: 'Checking the sum.', reasoning: 'Calculate.', providerState: state,
        toolCalls: [{ id: 'calc', name: 'calculator', arguments: { expression: '2+2' } }] };
    }).mockImplementationOnce(async (args) => {
      requests.push(structuredClone(args.messages));
      args.onReasoning?.('Verified.');
      args.onContent?.('The answer is 4.');
      return { content: 'The answer is 4.', reasoning: 'Verified.' };
    });
    const onReasoning = vi.fn();
    const onContent = vi.fn();
    const result = await runAgentTask({ chatId: 'test-home', rawPrompt: 'Calculate 2+2', messages: [{ role: 'user', content: 'Calculate 2+2' }],
      agentProfile: 'chat', maxIterations: 6, onStep: vi.fn(), onArtifact: vi.fn(), onReasoning, onContent });
    expect(result.content).toBe('The answer is 4.');
    expect(onReasoning).toHaveBeenLastCalledWith('Calculate.\n\nVerified.');
    expect(onContent).toHaveBeenCalledWith('Checking the sum.');
    const second = requests[1] as Array<Record<string, any>>;
    const parent = second.findIndex(m => m.tool_calls?.[0]?.id === 'calc');
    expect(second[parent].providerState).toEqual(state);
    expect(second[parent].reasoning_content).toBe('Calculate.');
    expect(second[parent + 1].tool_call_id).toBe('calc');
    expect(second[parent + 1].content).toContain('4');
  });
});

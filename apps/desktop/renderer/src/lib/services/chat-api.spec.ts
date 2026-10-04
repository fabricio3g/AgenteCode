import { describe, expect, it } from 'vitest';
import type { AppConfig } from '$lib/types/chat';
import { buildReasoningRequest, isVisionModel, normalizeRuntimeUsage, readCompletionWithTools, reasoningRouteIdentity, supportsNativeTools, toRequestMessages } from './chat-api';

describe('chat-api vision message conversion', () => {
  it('preserves reasoning, opaque signed state and paired tool identities across IPC conversion', () => {
    const providerState = { provider: 'gemini', blocks: [{ thoughtSignature: 'opaque==', functionCall: { name: 'calculator', args: {} } }] };
    const messages = toRequestMessages([
      { role: 'assistant', content: '', reasoning_content: 'original reasoning', providerState,
        tool_calls: [{ id: 'a', type: 'function', function: { name: 'calculator', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'a', name: 'calculator', content: '4' }
    ]);
    expect(messages[0].reasoning_content).toBe('original reasoning');
    expect(messages[0].providerState).toEqual(providerState);
    expect(messages[1].tool_call_id).toBe('a');
  });

  it('does not stringify existing multimodal parts into object text', () => {
    const content = [{ type: 'text' as const, text: 'Describe' }, { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,test' } }];
    expect(toRequestMessages([{ role: 'user', content }])[0].content).toEqual(content);
  });
  const imageAttachment = {
    id: 'att-1',
    name: 'scan.png',
    size: 12,
    type: 'image/png',
    kind: 'image' as const,
    status: 'ready' as const,
    base64: 'data:image/png;base64,abc123',
    ocrText: 'fallback text'
  };

  it('sends image attachments as multimodal parts for vision-capable models', () => {
    const [message] = toRequestMessages([
      { role: 'user', content: 'What is in this image?', attachments: [imageAttachment] }
    ], 'qwen-vl', true);

    expect(Array.isArray(message.content)).toBe(true);
    expect(message.content).toEqual([
      { type: 'text', text: 'What is in this image?\n\n--- Attached file contents ---\n[scan.png]: fallback text' },
      { type: 'image_url', image_url: { url: imageAttachment.base64, detail: 'auto' } }
    ]);
  });

  it('falls back to extracted text when a model is not vision-capable', () => {
    const [message] = toRequestMessages([
      { role: 'user', content: 'Read this', attachments: [imageAttachment] }
    ], 'text-only-model', false);

    expect(message.content).toBe('Read this\n\n--- Attached file contents ---\n[scan.png]: fallback text');
  });

  it('recognizes common local and API vision model names', () => {
    expect(isVisionModel('Qwen2.5-VL-7B')).toBe(true);
    expect(isVisionModel('gpt-4o-mini')).toBe(true);
    expect(isVisionModel('plain-llama-text')).toBe(false);
  });

  it('caps images to newest 20 when history has more than 20 image attachments', () => {
    const messages = Array.from({ length: 25 }, (_, i) => ({
      role: 'user' as const,
      content: `Turn ${i}`,
      attachments: [{
        id: `att-${i}`,
        name: `image-${i}.png`,
        kind: 'image' as const,
        status: 'ready' as const,
        base64: `data:image/png;base64,data${i}`
      }]
    }));

    const converted = toRequestMessages(messages, 'gpt-4o', true);
    expect(converted).toHaveLength(25);

    // Oldest 5 messages (indices 0..4) should have omitted note and text-only content
    for (let i = 0; i < 5; i++) {
      expect(Array.isArray(converted[i].content)).toBe(false);
      expect(typeof converted[i].content).toBe('string');
      expect(converted[i].content).toContain(`[Image: image-${i}.png (omitted from earlier history to stay under provider image limit)]`);
    }

    // Newest 20 messages (indices 5..24) should have image_url parts
    for (let i = 5; i < 25; i++) {
      expect(Array.isArray(converted[i].content)).toBe(true);
      const parts = converted[i].content as Array<{ type: string; image_url?: { url: string } }>;
      const imagePart = parts.find((p) => p.type === 'image_url');
      expect(imagePart?.image_url?.url).toBe(`data:image/png;base64,data${i}`);
    }
  });
});

describe('chat-api local backend routing helpers', () => {
  it('tries native tools for the local backend even before probing (fail open)', () => {
    const config = {
      llm: {
        backend_mode: 'local',
        provider: 'openai',
        local: { model: 'local-routing-test-model' },
        providers: {
          openai: { model: 'gpt-4o', base_url: 'https://api.openai.com/v1' }
        }
      }
    };

    // The agent falls back to XML when the model rejects tools, so an uncached
    // local backend must attempt native tools rather than skipping them — the
    // local server honors tool definitions it understands (llama.cpp renders
    // them through the model's Jinja template).
    expect(supportsNativeTools(config)).toBe(true);
  });
});

describe('llama.cpp runtime telemetry', () => {
  it('preserves OpenAI usage keys and native generation timings', () => {
    const usage = normalizeRuntimeUsage(
      { prompt_tokens: 137, completion_tokens: 276, total_tokens: 413 },
      { prompt_ms: 1200, predicted_ms: 5000, predicted_per_second: 55.2 }
    );

    expect(usage).toMatchObject({
      prompt_tokens: 137,
      completion_tokens: 276,
      total_tokens: 413,
      timings: { predicted_ms: 5000, predicted_per_second: 55.2 }
    });
  });

  it('returns null when a response contains neither usage nor timings', () => {
    expect(normalizeRuntimeUsage(null, null)).toBeNull();
  });
});

describe('reasoning level builder', () => {
  it('keeps off as a real level instead of collapsing it to unset', () => {
    // 'off' must reach the dialects: local maps it to enable_thinking:false,
    // gemini to budget 0, deepseek to disabled. Only null/undefined omits.
    expect(buildReasoningRequest('off')).toEqual({ level: 'off' });
    expect(buildReasoningRequest('on')).toEqual({ level: 'on' });
    expect(buildReasoningRequest(null)).toBeUndefined();
    expect(buildReasoningRequest(undefined)).toBeUndefined();
  });
});

describe('reasoning route identity', () => {
  const local = (over: { model?: string; selected_model_path?: string } = {}): AppConfig => ({
    llm: { backend_mode: 'local', local: { model: 'm', selected_model_path: '/p/a.gguf', ...over } }
  });
  const api = (provider = 'openrouter', over: { base_url?: string; model?: string } = {}): AppConfig => ({
    llm: { backend_mode: 'api', provider, providers: { [provider]: { base_url: 'https://x.test/v1', model: 'm1', ...over } } }
  });

  it('is stable for the same route', () => {
    expect(reasoningRouteIdentity(local())).toBe(reasoningRouteIdentity(local()));
    expect(reasoningRouteIdentity(api())).toBe(reasoningRouteIdentity(api()));
  });

  it('changes on every route-affecting switch', () => {
    const base = reasoningRouteIdentity(local());
    // Backend toggle (the reported stale-chip case).
    expect(reasoningRouteIdentity(api())).not.toBe(base);
    // Local GGUF swap (different template = different thinking support).
    expect(reasoningRouteIdentity(local({ selected_model_path: '/p/b.gguf' }))).not.toBe(base);
    expect(reasoningRouteIdentity(local({ model: 'other' }))).not.toBe(base);
    // Provider activation and model change.
    const openrouter = reasoningRouteIdentity(api());
    expect(reasoningRouteIdentity(api('groq'))).not.toBe(openrouter);
    expect(reasoningRouteIdentity(api('openrouter', { model: 'm2' }))).not.toBe(openrouter);
    expect(reasoningRouteIdentity(api('openrouter', { base_url: 'https://y.test/v1' }))).not.toBe(openrouter);
  });

  it('ignores unrelated settings so saves do not re-probe', () => {
    const config = api();
    const before = reasoningRouteIdentity(config);
    config.llm!.providers!['openrouter']!.temperature = 0.9;
    expect(reasoningRouteIdentity(config)).toBe(before);
  });
});


describe('completion tool decoding', () => {
  it('preserves flat provider state, object arguments and tool identities', () => {
    const state = { provider: 'openrouter', blocks: [{ signature: 'opaque' }] };
    const result = readCompletionWithTools({ content: '', reasoning: 'plan', providerState: state,
      toolCalls: [{ id: 'tool-1', name: 'read_file', arguments: { path: 'a.rs' } }] });
    expect(result.providerState).toBe(state);
    expect(result.toolCalls).toEqual([{ id: 'tool-1', name: 'read_file', arguments: { path: 'a.rs' } }]);
    expect(result.reasoning).toBe('plan');
  });

  it('decodes OpenAI function calls while keeping an explicitly empty reasoning field', () => {
    const result = readCompletionWithTools({ choices: [{ message: { content: 'answer', reasoning_content: '', thinking: 'fallback',
      tool_calls: [{ id: 'tool-2', function: { name: 'search', arguments: '{"query":"rust"}' } }] } }], usage: { total_tokens: 9 } });
    expect(result).toMatchObject({ content: 'answer', reasoning: '', usage: { total_tokens: 9 },
      toolCalls: [{ id: 'tool-2', name: 'search', arguments: { query: 'rust' } }] });
  });

  it('discards unnamed calls and handles malformed arguments without dropping the named call', () => {
    const result = readCompletionWithTools({ content: 'ok', toolCalls: [{ name: '' }, { name: 'write_file', arguments: '{broken' }] });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]).toMatchObject({ name: 'write_file', arguments: {} });
    expect(result.toolCalls?.[0].id).toMatch(/^call_/);
  });
});

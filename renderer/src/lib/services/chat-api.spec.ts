import { describe, expect, it } from 'vitest';
import { buildReasoningRequest, isVisionModel, normalizeRuntimeUsage, supportsNativeTools, toRequestMessages } from './chat-api';

describe('chat-api vision message conversion', () => {
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

import { describe, expect, it } from 'vitest';
import { isVisionModel, supportsNativeTools, toRequestMessages } from './chat-api';

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
  it('does not treat local backend as the configured API provider for tool support', () => {
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

    expect(supportsNativeTools(config)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildLocalModelRuntimeRequest,
  buildLocalModelSettingsPatch,
  buildRememberedLocalModelSettingsEntry,
  normalizeThinkingMode,
  resolveLocalModelLoadState
} from '$lib/stores/app-store-local-model';

describe('app-store-local-model', () => {
  it('prefers remembered values, then recommended values, then config fallbacks', () => {
    const state = resolveLocalModelLoadState({
      remembered: { context_length: 16384, gpu_offload: 24, flash_attention: false },
      config: {
        llm: {
          local: {
            cpu_threads: 8,
            batch_size: 1024,
            cache_type_k: 'q8_0'
          }
        }
      },
      model: { id: 'llama', name: 'Llama', context_length: 4096 },
      runtimePath: 'D:/runtime',
      recommended: { context_length: 8192, gpu_layers: 16, use_mmap: false },
      hardwareConcurrency: 12,
      mmprojPath: 'D:/models/mmproj.gguf'
    });

    expect(state.contextLength).toBe('16384');
    expect(state.gpuLayers).toBe('24');
    expect(state.cpuThreads).toBe('8');
    expect(state.batchSize).toBe('1024');
    expect(state.flashAttention).toBe(false);
    expect(state.mmap).toBe(false);
    expect(state.cacheTypeK).toBe('q8_0');
    expect(state.mmprojPath).toBe('D:/models/mmproj.gguf');
  });

  it('builds stable settings payloads and runtime request', () => {
    const state = resolveLocalModelLoadState({
      remembered: {},
      config: {},
      model: { id: 'mistral', name: 'Mistral', path: 'D:/models/mistral.gguf' },
      runtimePath: 'D:/runtime',
      hardwareConcurrency: 6
    });

    const patch = buildLocalModelSettingsPatch(state);
    const remembered = buildRememberedLocalModelSettingsEntry(state);
    const request = buildLocalModelRuntimeRequest({
      config: {},
      target: { id: 'mistral', name: 'Mistral', path: 'D:/models/mistral.gguf' },
      state
    });

    expect(patch.runtime_path).toBe('D:/runtime');
    expect(remembered.runtime_path).toBe('D:/runtime');
    expect(request.modelPath).toBe('D:/models/mistral.gguf');
    expect(request.runtimePath).toBe('D:/runtime');
    expect(request.config.llm?.local?.selected_model_path).toBe('D:/models/mistral.gguf');
  });

  it('defaults the thinking mode to auto and migrates the legacy boolean', () => {
    expect(normalizeThinkingMode(undefined, undefined)).toBe('auto');
    expect(normalizeThinkingMode('off', undefined)).toBe('off');
    expect(normalizeThinkingMode('on', undefined)).toBe('on');
    expect(normalizeThinkingMode('bogus', undefined)).toBe('auto');
    // Legacy `disable_thinking: true` still means off; false means auto.
    expect(normalizeThinkingMode(undefined, true)).toBe('off');
    expect(normalizeThinkingMode(undefined, false)).toBe('auto');
    // The new key wins over the legacy boolean.
    expect(normalizeThinkingMode('on', true)).toBe('on');

    const migrated = resolveLocalModelLoadState({
      remembered: { disable_thinking: true },
      config: {},
      model: { id: 'm', name: 'M', path: 'D:/m.gguf' },
      runtimePath: 'D:/runtime'
    });
    expect(migrated.thinkingMode).toBe('off');

    const fresh = resolveLocalModelLoadState({
      remembered: {},
      config: {},
      model: { id: 'm', name: 'M', path: 'D:/m.gguf' },
      runtimePath: 'D:/runtime'
    });
    expect(fresh.thinkingMode).toBe('auto');
    const freshPatch = buildLocalModelSettingsPatch(fresh);
    expect(freshPatch.thinking_mode).toBeUndefined();
    // Auto must clear a stale legacy flag rather than fight it.
    expect(freshPatch.disable_thinking).toBeUndefined();
    const offRequest = buildLocalModelRuntimeRequest({
      config: {},
      target: { id: 'm', name: 'M', path: 'D:/m.gguf' },
      state: { ...fresh, thinkingMode: 'off' }
    });
    expect(offRequest.thinkingMode).toBe('off');
  });
});

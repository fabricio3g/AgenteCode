import { describe, expect, it } from 'vitest';
import {
  buildLocalModelRuntimeRequest,
  buildLocalModelSettingsPatch,
  buildRememberedLocalModelSettingsEntry,
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
});

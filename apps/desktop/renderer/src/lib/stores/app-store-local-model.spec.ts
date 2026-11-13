import { describe, expect, it } from 'vitest';
import {
  localWithLoadState,
  normalizeThinkingMode,
  resolveLocalModelLoadState
} from '$lib/stores/app-store-local-model';
import { launchConfigFromSaved } from '$shared/local-launch';
import type { AppConfig } from '$lib/types/chat';

const QWEN = 'D:/models/qwen.gguf';
const LFM = 'D:/models/lfm.gguf';
const model = (path: string) => ({ id: path, name: path, path });
const withLocal = (local: Record<string, unknown>): AppConfig => ({ llm: { local } } as AppConfig);

describe('app-store-local-model', () => {
  it('opens a model with nothing saved on auto, with the switches at llama.cpp defaults', () => {
    const state = resolveLocalModelLoadState({ config: {}, model: model(QWEN), runtimePath: 'D:/runtime' });
    expect(state.contextLength).toBe('');
    expect(state.gpuLayers).toBe('');
    expect(state.cpuThreads).toBe('');
    expect(state.batchSize).toBe('');
    expect(state.cacheTypeK).toBe('');
    expect(state.keepInMemory).toBe(false);
    expect(state.mmap).toBe(true);
    expect(state.thinkingMode).toBe('auto');
    expect(state.parallel).toBe('4');
  });

  it('opens a model with its own saved config and never another model’s', () => {
    const config = withLocal({
      parallel: 2,
      load_configs: { [QWEN]: { context_length: 32768, gpu_layers: 24, thinking_mode: 'off' } }
    });
    const qwen = resolveLocalModelLoadState({ config, model: model(QWEN), runtimePath: '' });
    expect(qwen.contextLength).toBe('32768');
    expect(qwen.gpuLayers).toBe('24');
    expect(qwen.thinkingMode).toBe('off');
    expect(qwen.parallel).toBe('2');

    const lfm = resolveLocalModelLoadState({ config, model: model(LFM), runtimePath: '' });
    expect(lfm.contextLength).toBe('');
    expect(lfm.gpuLayers).toBe('');
    expect(lfm.thinkingMode).toBe('auto');
  });

  it('reads a legacy top-level config as the selected file’s, once', () => {
    const config = withLocal({ selected_model_path: QWEN, context_length: 16384, gpu_layers: 0 });
    expect(resolveLocalModelLoadState({ config, model: model(QWEN), runtimePath: '' }).contextLength).toBe('16384');
    expect(resolveLocalModelLoadState({ config, model: model(LFM), runtimePath: '' }).contextLength).toBe('');
  });

  it('saves only what changed, keeps Auto as auto, and launches exactly that', () => {
    const fresh = resolveLocalModelLoadState({ config: {}, model: model(LFM), runtimePath: 'D:/vulkan/llama-server.exe' });
    const local = localWithLoadState({}, LFM, { ...fresh, contextLength: '65536', thinkingMode: 'on' }) as Record<string, unknown>;
    expect(local.load_configs).toEqual({ [LFM.toLowerCase()]: { context_length: 65536, thinking_mode: 'on' } });
    expect(local.runtime_path).toBe('D:/vulkan/llama-server.exe');
    expect(local.parallel).toBe(4);

    const launch = launchConfigFromSaved({ ...local, selected_model_path: LFM }, LFM);
    expect(launch.context_length).toBe(65536);
    expect(launch.thinking_mode).toBe('on');
    expect(launch.gpu_offload).toBeUndefined();
    expect(launch.cpu_threads).toBeUndefined();
    expect(launch.keep_in_memory).toBeUndefined();

    // Back to Auto: the entry empties and nothing is pinned.
    const reset = localWithLoadState(local, LFM, { ...fresh }) as Record<string, unknown>;
    expect(reset.load_configs).toEqual({});
  });

  it('keeps the previous model’s legacy config when another model is saved', () => {
    const legacy = { selected_model_path: QWEN, context_length: 32768, gpu_layers: 24, thinking_mode: 'off' };
    const fresh = resolveLocalModelLoadState({ config: withLocal(legacy), model: model(LFM), runtimePath: '' });
    const local = localWithLoadState(legacy, LFM, fresh) as Record<string, unknown>;
    expect(local.context_length).toBeUndefined();
    expect(local.gpu_layers).toBeUndefined();
    expect((local.load_configs as Record<string, unknown>)[QWEN.toLowerCase()])
      .toEqual({ context_length: 32768, gpu_layers: 24, thinking_mode: 'off' });
  });

  it('normalizes the thinking mode and its legacy boolean', () => {
    expect(normalizeThinkingMode(undefined, undefined)).toBe('auto');
    expect(normalizeThinkingMode('off', undefined)).toBe('off');
    expect(normalizeThinkingMode('on', undefined)).toBe('on');
    expect(normalizeThinkingMode('bogus', undefined)).toBe('auto');
    expect(normalizeThinkingMode(undefined, true)).toBe('off');
    expect(normalizeThinkingMode(undefined, false)).toBe('auto');
    expect(normalizeThinkingMode('on', true)).toBe('on');
  });
});

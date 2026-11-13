import { describe, expect, it } from 'vitest';
import { launchConfigFromSaved, launchSignature, localBindAddress } from '$shared/local-launch';

const MODEL = 'C:\\Models\\LFM3-1.7B.gguf';

describe('launchConfigFromSaved', () => {
  it('leaves unset sizing off the launch so llama.cpp --fit decides', () => {
    const launch = launchConfigFromSaved({ selected_model_path: MODEL }, MODEL);
    expect(launch).toEqual({ model_path: MODEL, backend_mode: 'auto', host: '127.0.0.1', port: 11435 });
  });

  it('keeps what was chosen for the same file, whatever the path spelling', () => {
    const launch = launchConfigFromSaved({
      parallel: 4,
      load_configs: { 'C:/Models/LFM3-1.7B.gguf': { context_length: 32768, gpu_layers: 0, thinking_mode: 'off', cache_type_k: 'q8_0' } }
    }, MODEL);
    expect(launch.context_length).toBe(32768);
    // 0 GPU layers is a real choice (CPU only), not "unset".
    expect(launch.gpu_offload).toBe(0);
    expect(launch.thinking_mode).toBe('off');
    expect(launch.cache_type_k).toBe('q8_0');
    expect(launch.parallel).toBe(4);
  });

  it('migrates a legacy config without the values old builds wrote on their own', () => {
    const launch = launchConfigFromSaved({
      selected_model_path: 'c:/models/lfm3-1.7b.gguf',
      context_length: 32768,
      thinking_mode: 'off',
      // Seeded or pre-filled by older builds, never picked by a person:
      gpu_layers: 0, cpu_threads: 6, batch_size: 256, keep_in_memory: true, cache_type_k: 'f16'
    }, MODEL);
    expect(launch.context_length).toBe(32768);
    expect(launch.thinking_mode).toBe('off');
    for (const key of ['gpu_offload', 'cpu_threads', 'batch_size', 'keep_in_memory', 'cache_type_k'] as const) {
      expect(launch[key], key).toBeUndefined();
    }
    // The seeded 4,096 context is not a choice either.
    expect(launchConfigFromSaved({ selected_model_path: MODEL, context_length: 4096 }, MODEL).context_length).toBeUndefined();
  });

  it('never carries one model’s settings to another, only the app-wide ones', () => {
    const launch = launchConfigFromSaved({
      selected_model_path: 'C:/Models/Other-70B.gguf',
      context_length: 262144,
      gpu_layers: 0,
      thinking_mode: 'on',
      runtime_path: 'C:/engines/vulkan/llama-server.exe',
      parallel: 2,
      base_url: 'http://0.0.0.0:11440/v1'
    }, MODEL);
    expect(launch).toEqual({
      model_path: MODEL,
      backend_mode: 'auto',
      host: '0.0.0.0',
      port: 11440,
      runtime_path: 'C:/engines/vulkan/llama-server.exe',
      parallel: 2
    });
  });

  it('reads the legacy thinking flag and treats auto as absent', () => {
    expect(launchConfigFromSaved({ selected_model_path: MODEL, disable_thinking: true }, MODEL).thinking_mode).toBe('off');
    expect(launchConfigFromSaved({ selected_model_path: MODEL, thinking_mode: 'auto', disable_thinking: true }, MODEL).thinking_mode).toBeUndefined();
  });

  it('ignores junk and empty values instead of passing them on', () => {
    const launch = launchConfigFromSaved({ selected_model_path: MODEL, context_length: '', cpu_threads: 'abc', seed: null, mmproj_path: '  ' }, MODEL);
    expect(launch.context_length).toBeUndefined();
    expect(launch.cpu_threads).toBeUndefined();
    expect(launch.seed).toBeUndefined();
    expect(launch.mmproj_path).toBeUndefined();
  });
});

describe('launchSignature', () => {
  it('changes when any launch setting changes, thinking included', () => {
    const base = { model_path: MODEL, port: 11435 };
    expect(launchSignature({ ...base, thinking_mode: 'off' })).not.toBe(launchSignature(base));
  });

  it('ignores key order, path spelling, empty values and the per-launch key', () => {
    expect(launchSignature({ model_path: MODEL, port: 11435, seed: undefined, api_key: 'a' }))
      .toBe(launchSignature({ port: 11435, model_path: 'c:/models/lfm3-1.7b.gguf', api_key: 'b' }));
  });
});

describe('localBindAddress', () => {
  it('falls back to the default port on a bad URL', () => {
    expect(localBindAddress({ base_url: 'not a url' })).toEqual({ host: '127.0.0.1', port: 11435 });
  });
});

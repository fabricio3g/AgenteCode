import { describe, expect, it } from 'vitest';
import { describeLocalLoadError } from './local-load-errors';

describe('describeLocalLoadError', () => {
  it('names the usual failures in plain words', () => {
    expect(describeLocalLoadError('ggml_backend_cuda_buffer_type_alloc_buffer: cudaMalloc failed: out of memory')).toMatch(/Not enough memory/);
    expect(describeLocalLoadError('listen EADDRINUSE: address already in use 127.0.0.1:11435')).toMatch(/port/);
    expect(describeLocalLoadError('spawn /x/llama-server ENOENT')).toMatch(/runtime/);
    expect(describeLocalLoadError('gguf_init_from_file: invalid magic characters')).toMatch(/couldn't be read/);
  });

  it('keeps the reason when it does not recognise the failure', () => {
    expect(describeLocalLoadError('something odd')).toBe('The model failed to load: something odd');
  });

  it('points unsupported architectures to the runtime instead of blaming the GGUF', () => {
    expect(describeLocalLoadError('failed to load model: unknown model architecture: future_arch')).toMatch(/runtime/);
  });
});

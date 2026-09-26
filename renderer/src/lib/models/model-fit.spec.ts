import { describe, expect, it } from 'vitest';
import { assessModelFit, recommendCuratedModels } from './model-fit';
import type { HardwareInfo } from '$lib/types/bridge';

const hardware = (patch: Partial<HardwareInfo> = {}): HardwareInfo => ({
  total_ram_gb: 32,
  free_ram_gb: 24,
  physical_cores: 8,
  cpu_threads: 16,
  cpu_model: 'Test CPU',
  vram_gb: 12,
  gpu_name: 'Test GPU',
  gpu_backend: 'cuda',
  os_platform: 'test',
  os_arch: 'x64',
  ...patch,
});

const artifact = (gb: number, projectorGb = 0) => ({
  sizeBytes: gb * 1024 ** 3,
  projectorBytes: projectorGb * 1024 ** 3,
});

describe('assessModelFit', () => {
  it('returns unknown without hardware and lets runtime incompatibility override it', () => {
    expect(assessModelFit({ artifact: artifact(2) }).status).toBe('unknown');
    expect(assessModelFit({
      artifact: artifact(2),
      requirement: { architectures: ['future'] },
      runtime: { supportedArchitectures: ['llama'] },
    }).status).toBe('runtime_update');
  });

  it('handles full and partial CUDA/Vulkan offload separately', () => {
    expect(assessModelFit({ artifact: artifact(4), hardware: hardware() }).offload).toBe('full_gpu');
    const partial = assessModelFit({ artifact: artifact(14), hardware: hardware() });
    expect(partial.offload).toBe('partial_gpu');
    expect(partial.status).toBe('constrained');
  });

  it('does not add VRAM to Metal or estimated/shared GPUs', () => {
    const metal = assessModelFit({
      artifact: artifact(13),
      hardware: hardware({ gpu_backend: 'metal', vram_gb: 24, free_ram_gb: 4, total_ram_gb: 16 }),
    });
    expect(metal.offload).toBe('unified');
    expect(metal.status).toBe('unlikely');

    const estimated = assessModelFit({
      artifact: artifact(13),
      hardware: hardware({ gpu_backend: 'vulkan', vram_estimated: true, vram_gb: 24, free_ram_gb: 4, total_ram_gb: 16 }),
    });
    expect(estimated.offload).toBe('unified');
    expect(estimated.status).toBe('unlikely');
  });

  it('distinguishes current free memory from capacity after closing applications', () => {
    const fit = assessModelFit({
      artifact: artifact(8),
      hardware: hardware({ gpu_backend: 'cpu', vram_gb: 0, total_ram_gb: 16, free_ram_gb: 3 }),
    });
    expect(fit.status).toBe('constrained');
    expect(fit.reason).toContain('closing applications');
  });

  it('includes projector and quant artifact sizes in estimates', () => {
    const small = assessModelFit({ artifact: artifact(2), hardware: hardware() });
    const largerQuant = assessModelFit({ artifact: artifact(4), hardware: hardware() });
    const projector = assessModelFit({ artifact: artifact(2, 1), hardware: hardware() });
    expect(largerQuant.estimatedWorkingMemoryBytes).toBeGreaterThan(small.estimatedWorkingMemoryBytes);
    expect(projector.estimatedWorkingMemoryBytes).toBeGreaterThan(small.estimatedWorkingMemoryBytes);
  });
});

describe('recommendCuratedModels', () => {
  it('uses Qwen3.5 4B as the neutral default and produces three hardware recommendations', () => {
    expect(recommendCuratedModels(null).defaultModel.id).toBe('qwen3.5-4b');
    const result = recommendCuratedModels(hardware(), {
      version: 'b10159',
      supportedArchitectures: ['lfm2', 'llama', 'gemma4', 'qwen35', 'mistral3'],
    });
    expect(result.fastest).toBeTruthy();
    expect(result.balance).toBeTruthy();
    expect(result.quality).toBeTruthy();
  });
});

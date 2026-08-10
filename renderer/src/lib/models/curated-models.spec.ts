import { describe, expect, it } from 'vitest';
import { CURATED_MODELS, defaultArtifact } from './curated-models';

describe('curated model registry', () => {
  it('is stable, unique, public, and spans the intended range', () => {
    expect(CURATED_MODELS.map((model) => model.parametersB)).toEqual([1.2, 2, 4, 8, 9, 14, 27]);
    expect(new Set(CURATED_MODELS.map((model) => model.id)).size).toBe(CURATED_MODELS.length);
    expect(CURATED_MODELS.every((model) => model.access === 'public')).toBe(true);
    expect(CURATED_MODELS.every((model) => Boolean(model.license))).toBe(true);
  });

  it('uses reviewed publishers and complete default artifacts', () => {
    const allowedPublishers = new Set(['LiquidAI', 'Qwen', 'mistralai', 'ggml-org']);
    for (const model of CURATED_MODELS) {
      expect(allowedPublishers.has(model.ggufRepository.split('/')[0])).toBe(true);
      expect(model.runtime.architectures).toContain(model.architecture);
      expect(model.lastReviewed).toMatch(/^20\d\d-\d\d-\d\d$/);
      const selected = defaultArtifact(model);
      expect(selected.quantization).toBe(model.defaultQuant);
      expect(selected.filename.toLowerCase()).toMatch(/\.gguf$/);
      expect(selected.sizeBytes).toBeGreaterThan(0);
    }
  });
});

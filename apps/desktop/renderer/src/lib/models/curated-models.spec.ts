import { describe, expect, it } from 'vitest';
import { CURATED_MODELS, defaultArtifact, memoryTierOf } from './curated-models';

describe('curated model registry', () => {
  it('is stable, unique, public, and spans the intended range', () => {
    const sizes = CURATED_MODELS.map((model) => defaultArtifact(model).sizeBytes);
    expect(sizes.length).toBeGreaterThanOrEqual(8);
    // Small machines first: every memory tier from 4 GB up to 24 GB is covered.
    expect(new Set(CURATED_MODELS.map(memoryTierOf))).toEqual(new Set([4, 8, 16, 24]));
    expect(new Set(CURATED_MODELS.map((model) => model.id)).size).toBe(CURATED_MODELS.length);
    expect(CURATED_MODELS.every((model) => model.access === 'public')).toBe(true);
    expect(CURATED_MODELS.every((model) => Boolean(model.license))).toBe(true);
  });

  it('uses reviewed publishers and complete default artifacts', () => {
    const allowedPublishers = new Set(['LiquidAI', 'openbmb', 'mistralai', 'ggml-org', 'unsloth', 'ibm-granite']);
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

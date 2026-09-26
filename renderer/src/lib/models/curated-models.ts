import type { CuratedModelDefinition, ModelArtifact } from '$lib/types/model-hub';

const GB = 1024 ** 3;
const artifact = (
  filename: string,
  quantization: string,
  sizeGb: number,
  recommended = false,
  projectorGb = 0,
): ModelArtifact => ({
  filename,
  quantization,
  sizeBytes: Math.round(sizeGb * GB),
  recommended,
  projectorBytes: projectorGb ? Math.round(projectorGb * GB) : undefined,
});

/**
 * Reviewed, public one-click choices, from the smallest machine to the
 * largest. Keep ordering stable: it is also the quality ranking used by
 * hardware recommendations. Files and sizes come from each repository's
 * Hugging Face listing (reviewed 2026-09-23); `architecture` is the GGUF
 * `general.architecture`, which the runtime check matches against.
 */
export const CURATED_MODELS: readonly CuratedModelDefinition[] = [
  {
    id: 'lfm2.5-1.2b-instruct',
    name: 'LFM2.5 1.2B Instruct',
    upstreamRepository: 'LiquidAI/LFM2.5-1.2B-Instruct',
    ggufRepository: 'LiquidAI/LFM2.5-1.2B-Instruct-GGUF',
    role: 'fastest',
    parametersB: 1.2,
    architecture: 'lfm2',
    capabilities: ['Chat', 'Tools'],
    license: 'LFM Open License 1.0',
    access: 'public',
    defaultQuant: 'Q4_K_M',
    artifacts: [
      artifact('LFM2.5-1.2B-Instruct-Q4_K_M.gguf', 'Q4_K_M', 0.681, true),
      artifact('LFM2.5-1.2B-Instruct-Q8_0.gguf', 'Q8_0', 1.161),
    ],
    runtime: { architectures: ['lfm2'] },
    rank: 1,
    lastReviewed: '2026-09-23',
  },
  {
    id: 'minicpm5-2b',
    name: 'MiniCPM5 2B',
    upstreamRepository: 'openbmb/MiniCPM5-2B',
    ggufRepository: 'openbmb/MiniCPM5-2B-GGUF',
    role: 'smallAllRounder',
    parametersB: 2.5,
    architecture: 'llama',
    capabilities: ['Chat', 'Tools', 'Multilingual'],
    license: 'Apache-2.0',
    access: 'public',
    defaultQuant: 'Q4_K_M',
    artifacts: [
      artifact('MiniCPM5-2B-Q4_K_M.gguf', 'Q4_K_M', 1.454, true),
      artifact('MiniCPM5-2B-Q8_0.gguf', 'Q8_0', 2.496),
    ],
    runtime: { architectures: ['llama'] },
    rank: 2,
    lastReviewed: '2026-09-23',
  },
  {
    id: 'gemma-4-e2b',
    name: 'Gemma 4 E2B',
    upstreamRepository: 'google/gemma-4-E2B-it',
    ggufRepository: 'ggml-org/gemma-4-E2B-it-GGUF',
    role: 'smallMultilingual',
    parametersB: 4.6,
    architecture: 'gemma4',
    capabilities: ['Chat', 'Multilingual'],
    license: 'Apache-2.0',
    access: 'public',
    defaultQuant: 'Q4_0',
    artifacts: [
      artifact('gemma-4-E2B-it-Q4_0.gguf', 'Q4_0', 2.646, true),
      artifact('gemma-4-E2B-it-Q8_0.gguf', 'Q8_0', 4.626),
    ],
    runtime: { architectures: ['gemma4'] },
    rank: 3,
    lastReviewed: '2026-09-23',
  },
  {
    id: 'qwen3.5-4b',
    name: 'Qwen3.5 4B',
    upstreamRepository: 'Qwen/Qwen3.5-4B',
    ggufRepository: 'unsloth/Qwen3.5-4B-GGUF',
    role: 'everyday',
    parametersB: 4.2,
    architecture: 'qwen35',
    capabilities: ['Chat', 'Tools', 'Multilingual'],
    license: 'Apache-2.0',
    access: 'public',
    defaultQuant: 'Q4_K_M',
    artifacts: [
      artifact('Qwen3.5-4B-Q4_K_M.gguf', 'Q4_K_M', 2.553, true),
      artifact('Qwen3.5-4B-Q5_K_M.gguf', 'Q5_K_M', 2.928),
      artifact('Qwen3.5-4B-Q8_0.gguf', 'Q8_0', 4.175),
    ],
    runtime: { architectures: ['qwen35'] },
    rank: 4,
    lastReviewed: '2026-09-23',
  },
  {
    id: 'gemma-4-e4b',
    name: 'Gemma 4 E4B',
    upstreamRepository: 'google/gemma-4-E4B-it',
    ggufRepository: 'ggml-org/gemma-4-E4B-it-GGUF',
    role: 'writing',
    parametersB: 7.5,
    architecture: 'gemma4',
    capabilities: ['Chat', 'Multilingual'],
    license: 'Apache-2.0',
    access: 'public',
    defaultQuant: 'Q4_0',
    artifacts: [
      artifact('gemma-4-E4B-it-Q4_0.gguf', 'Q4_0', 4.276, true),
      artifact('gemma-4-E4B-it-Q8_0.gguf', 'Q8_0', 7.48),
    ],
    runtime: { architectures: ['gemma4'] },
    rank: 5,
    lastReviewed: '2026-09-23',
  },
  {
    id: 'lfm2.5-8b-a1b',
    name: 'LFM2.5 8B-A1B',
    upstreamRepository: 'LiquidAI/LFM2.5-8B-A1B',
    ggufRepository: 'LiquidAI/LFM2.5-8B-A1B-GGUF',
    role: 'fastMoe',
    parametersB: 8.5,
    architecture: 'lfm2moe',
    capabilities: ['Chat', 'Tools'],
    license: 'LFM Open License 1.0',
    access: 'public',
    defaultQuant: 'Q4_K_M',
    artifacts: [
      artifact('LFM2.5-8B-A1B-Q4_K_M.gguf', 'Q4_K_M', 4.801, true),
      artifact('LFM2.5-8B-A1B-Q8_0.gguf', 'Q8_0', 8.391),
    ],
    runtime: { architectures: ['lfm2moe'] },
    rank: 6,
    lastReviewed: '2026-09-23',
  },
  {
    id: 'granite-4.2-8b',
    name: 'Granite 4.2 8B',
    upstreamRepository: 'ibm-granite/granite-4.2-8b',
    ggufRepository: 'ibm-granite/granite-4.2-8b-GGUF',
    role: 'workTools',
    parametersB: 8.8,
    architecture: 'granite',
    capabilities: ['Chat', 'Tools', 'Coding'],
    license: 'Apache-2.0',
    access: 'public',
    defaultQuant: 'Q4_K_M',
    artifacts: [
      artifact('granite-4.2-8b-Q4_K_M.gguf', 'Q4_K_M', 4.981, true),
      artifact('granite-4.2-8b-Q5_K_M.gguf', 'Q5_K_M', 5.824),
    ],
    runtime: { architectures: ['granite'] },
    rank: 7,
    lastReviewed: '2026-09-23',
  },
  {
    id: 'qwen3.5-9b',
    name: 'Qwen3.5 9B',
    upstreamRepository: 'Qwen/Qwen3.5-9B',
    ggufRepository: 'unsloth/Qwen3.5-9B-GGUF',
    role: 'agentic',
    parametersB: 9,
    architecture: 'qwen35',
    capabilities: ['Chat', 'Tools', 'Coding', 'Multilingual'],
    license: 'Apache-2.0',
    access: 'public',
    defaultQuant: 'Q4_K_M',
    artifacts: [
      artifact('Qwen3.5-9B-Q4_K_M.gguf', 'Q4_K_M', 5.29, true),
      artifact('Qwen3.5-9B-Q5_K_M.gguf', 'Q5_K_M', 6.126),
      artifact('Qwen3.5-9B-Q8_0.gguf', 'Q8_0', 8.873),
    ],
    runtime: { architectures: ['qwen35'] },
    rank: 8,
    lastReviewed: '2026-09-23',
  },
  {
    id: 'gemma-4-12b',
    name: 'Gemma 4 12B',
    upstreamRepository: 'google/gemma-4-12B-it',
    ggufRepository: 'unsloth/gemma-4-12b-it-GGUF',
    role: 'quality16',
    parametersB: 12,
    architecture: 'gemma4',
    capabilities: ['Chat', 'Tools', 'Multilingual'],
    license: 'Apache-2.0',
    access: 'public',
    defaultQuant: 'Q4_K_M',
    artifacts: [
      artifact('gemma-4-12b-it-Q4_K_M.gguf', 'Q4_K_M', 6.633, true),
      artifact('gemma-4-12b-it-Q5_K_M.gguf', 'Q5_K_M', 7.836),
    ],
    runtime: { architectures: ['gemma4'] },
    rank: 9,
    lastReviewed: '2026-09-23',
  },
  {
    id: 'ministral-3-14b-instruct',
    name: 'Ministral 3 14B',
    upstreamRepository: 'mistralai/Ministral-3-14B-Instruct-2512',
    ggufRepository: 'mistralai/Ministral-3-14B-Instruct-2512-GGUF',
    role: 'longContext',
    parametersB: 13.5,
    architecture: 'mistral3',
    capabilities: ['Chat', 'Tools', 'Multilingual'],
    license: 'Apache-2.0',
    access: 'public',
    defaultQuant: 'Q4_K_M',
    artifacts: [
      artifact('Ministral-3-14B-Instruct-2512-Q4_K_M.gguf', 'Q4_K_M', 7.674, true),
      artifact('Ministral-3-14B-Instruct-2512-Q5_K_M.gguf', 'Q5_K_M', 8.96),
    ],
    runtime: { architectures: ['mistral3'] },
    rank: 10,
    lastReviewed: '2026-09-23',
  },
  {
    id: 'gpt-oss-20b',
    name: 'gpt-oss 20B',
    upstreamRepository: 'openai/gpt-oss-20b',
    ggufRepository: 'ggml-org/gpt-oss-20b-GGUF',
    role: 'reasoning',
    parametersB: 21,
    architecture: 'gpt-oss',
    capabilities: ['Chat', 'Tools', 'Reasoning'],
    license: 'Apache-2.0',
    access: 'public',
    defaultQuant: 'MXFP4',
    artifacts: [artifact('gpt-oss-20b-MXFP4.gguf', 'MXFP4', 11.278, true)],
    runtime: { architectures: ['gpt-oss'] },
    rank: 11,
    lastReviewed: '2026-09-23',
  },
  {
    id: 'qwen3.8-27b',
    name: 'Qwen3.8 27B',
    upstreamRepository: 'Qwen/Qwen3.8-27B',
    ggufRepository: 'unsloth/Qwen3.8-27B-GGUF',
    role: 'best24',
    parametersB: 27,
    architecture: 'qwen35',
    capabilities: ['Chat', 'Tools', 'Coding', 'Multilingual'],
    license: 'Apache-2.0',
    access: 'public',
    defaultQuant: 'Q4_K_M',
    artifacts: [
      artifact('Qwen3.8-27B-UD-Q4_K_M.gguf', 'Q4_K_M', 15.334, true),
      artifact('Qwen3.8-27B-UD-Q5_K_M.gguf', 'Q5_K_M', 18.414),
    ],
    runtime: { architectures: ['qwen35'] },
    rank: 12,
    lastReviewed: '2026-09-23',
  },
  {
    id: 'qwen3.6-35b-a3b',
    name: 'Qwen3.6 35B-A3B',
    upstreamRepository: 'Qwen/Qwen3.6-35B-A3B',
    ggufRepository: 'unsloth/Qwen3.6-35B-A3B-GGUF',
    role: 'fastLarge',
    parametersB: 35,
    architecture: 'qwen35moe',
    capabilities: ['Chat', 'Tools', 'Coding', 'Multilingual'],
    license: 'Apache-2.0',
    access: 'public',
    defaultQuant: 'Q4_K_M',
    artifacts: [
      artifact('Qwen3.6-35B-A3B-UD-Q4_K_M.gguf', 'Q4_K_M', 20.614, true),
      artifact('Qwen3.6-35B-A3B-MXFP4_MOE.gguf', 'MXFP4', 20.215),
    ],
    runtime: { architectures: ['qwen35moe'] },
    rank: 13,
    lastReviewed: '2026-09-23',
  },
];

/** Memory sizes the curated list is grouped by, in GB. */
export const MEMORY_TIERS = [4, 8, 16, 24] as const;
export type MemoryTier = (typeof MEMORY_TIERS)[number];

/**
 * Smallest common memory size (RAM + VRAM) that runs the default file with
 * room for context: the file plus about a third again.
 */
export function memoryTierOf(model: CuratedModelDefinition): MemoryTier {
  const artifact = defaultArtifact(model);
  const needGb = ((artifact.sizeBytes + (artifact.projectorBytes ?? 0)) / GB) * 1.35;
  return MEMORY_TIERS.find((tier) => needGb <= tier) ?? 24;
}

export function defaultArtifact(model: CuratedModelDefinition): ModelArtifact {
  return model.artifacts.find((item) => item.quantization === model.defaultQuant)
    ?? model.artifacts.find((item) => item.recommended)
    ?? model.artifacts[0];
}

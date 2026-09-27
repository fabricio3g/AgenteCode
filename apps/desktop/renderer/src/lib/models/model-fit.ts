import { CURATED_MODELS, defaultArtifact } from './curated-models';
import type {
  AssessModelFitInput,
  CuratedModelDefinition,
  ModelFitAssessment,
  ModelRecommendations,
} from '$lib/types/model-hub';

const GB = 1024 ** 3;

function versionParts(value?: string): number[] {
  return String(value ?? '').match(/\d+/g)?.slice(0, 4).map(Number) ?? [];
}

function versionAtLeast(actual?: string, minimum?: string): boolean {
  if (!minimum || minimum === '0.0.0') return true;
  if (!actual) return false;
  const left = versionParts(actual);
  const right = versionParts(minimum);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

function runtimeCompatible(input: AssessModelFitInput): boolean {
  if (!input.requirement) return true;
  const supported = input.runtime?.supportedArchitectures;
  if (supported?.length && input.requirement.architectures.length) {
    const normalized = supported.map((item) => item.toLowerCase());
    if (!input.requirement.architectures.some((item) => normalized.includes(item.toLowerCase()))) return false;
  }
  return versionAtLeast(input.runtime?.version, input.requirement.minVersion);
}

export function estimateWorkingMemoryBytes(input: AssessModelFitInput): number {
  const artifactBytes = Math.max(0, Number(input.artifact.sizeBytes) || 0);
  const projectorBytes = Math.max(0, Number(input.artifact.projectorBytes) || 0);
  const parameterReserve = Math.max(0, Number(input.parametersB) || 0) * 0.04 * GB;
  const contextAndRuntimeReserve = Math.max(0.75 * GB, artifactBytes * 0.12, parameterReserve);
  return Math.ceil(artifactBytes + projectorBytes + contextAndRuntimeReserve);
}

export function assessModelFit(input: AssessModelFitInput): ModelFitAssessment {
  const artifactBytes = Math.max(0, Number(input.artifact.sizeBytes) || 0);
  const projectorBytes = Math.max(0, Number(input.artifact.projectorBytes) || 0);
  const estimatedWorkingMemoryBytes = estimateWorkingMemoryBytes(input);
  const base = { artifactBytes, projectorBytes, estimatedWorkingMemoryBytes };

  if (!runtimeCompatible(input)) {
    return {
      ...base,
      status: 'runtime_update',
      offload: 'unknown',
      reason: input.requirement?.reason || 'Update the local runtime before loading this architecture.',
    };
  }

  const hardware = input.hardware;
  if (!hardware || !hardware.total_ram_gb) {
    return {
      ...base,
      status: 'unknown',
      offload: 'unknown',
      reason: 'Hardware information is unavailable. Memory values are estimates, not a guaranteed fit.',
    };
  }

  const ramReserveGb = Math.max(2, hardware.total_ram_gb * 0.15);
  const usableRam = Math.max(0, hardware.total_ram_gb - ramReserveGb) * GB;
  const freeRam = Math.max(0, hardware.free_ram_gb - ramReserveGb) * GB;
  const vram = Math.max(0, hardware.vram_gb) * 0.85 * GB;
  const backend = String(hardware.gpu_backend || 'cpu').toLowerCase();
  const unified = backend === 'metal' || hardware.vram_estimated === true;

  if (unified) {
    if (estimatedWorkingMemoryBytes <= freeRam) {
      return { ...base, status: estimatedWorkingMemoryBytes <= freeRam * 0.6 ? 'excellent' : 'good', offload: 'unified', usableMemoryBytes: usableRam, currentlyFreeMemoryBytes: freeRam, reason: 'Estimated to fit in currently free unified memory.' };
    }
    if (estimatedWorkingMemoryBytes <= usableRam) {
      return { ...base, status: 'constrained', offload: 'unified', usableMemoryBytes: usableRam, currentlyFreeMemoryBytes: freeRam, reason: 'Estimated to fit after closing applications; current free memory is too low.' };
    }
    return { ...base, status: 'unlikely', offload: 'unified', usableMemoryBytes: usableRam, currentlyFreeMemoryBytes: freeRam, reason: 'Estimated working memory exceeds conservative unified-memory capacity.' };
  }

  if (backend !== 'cpu' && vram > 0 && estimatedWorkingMemoryBytes <= vram) {
    return { ...base, status: estimatedWorkingMemoryBytes <= vram * 0.6 ? 'excellent' : 'good', offload: 'full_gpu', usableMemoryBytes: vram, currentlyFreeMemoryBytes: freeRam, reason: 'Estimated to fit with full GPU offload after reserving 15% of VRAM.' };
  }
  const currentDiscreteCapacity = freeRam + (backend === 'cpu' ? 0 : vram);
  const conservativeDiscreteCapacity = usableRam + (backend === 'cpu' ? 0 : vram);
  if (estimatedWorkingMemoryBytes <= currentDiscreteCapacity) {
    return { ...base, status: backend === 'cpu' ? 'good' : 'constrained', offload: backend === 'cpu' ? 'cpu' : 'partial_gpu', usableMemoryBytes: conservativeDiscreteCapacity, currentlyFreeMemoryBytes: currentDiscreteCapacity, reason: backend === 'cpu' ? 'Estimated to fit in currently free system memory.' : 'Estimated to fit with partial GPU offload and currently free system memory.' };
  }
  if (estimatedWorkingMemoryBytes <= conservativeDiscreteCapacity) {
    return { ...base, status: 'constrained', offload: backend === 'cpu' ? 'cpu' : 'partial_gpu', usableMemoryBytes: conservativeDiscreteCapacity, currentlyFreeMemoryBytes: currentDiscreteCapacity, reason: 'Estimated to fit after closing applications; current free system memory is too low.' };
  }
  return { ...base, status: 'unlikely', offload: backend === 'cpu' ? 'cpu' : 'partial_gpu', usableMemoryBytes: conservativeDiscreteCapacity, currentlyFreeMemoryBytes: currentDiscreteCapacity, reason: 'Estimated working memory exceeds conservative available system memory.' };
}

export function recommendCuratedModels(
  hardware?: AssessModelFitInput['hardware'],
  runtime?: AssessModelFitInput['runtime'],
  models: readonly CuratedModelDefinition[] = CURATED_MODELS,
): ModelRecommendations {
  const defaultModel = models.find((model) => model.id === 'qwen3.5-4b') ?? models[0];
  if (!hardware) return { defaultModel };

  const assessed = models.map((model) => ({
    model,
    fit: assessModelFit({
      artifact: defaultArtifact(model),
      parametersB: model.parametersB,
      architecture: model.architecture,
      hardware,
      runtime,
      requirement: model.runtime,
    }),
  })).filter(({ fit }) => !['unlikely', 'runtime_update', 'unknown'].includes(fit.status));
  const usable = assessed[0]?.fit.usableMemoryBytes ?? 0;
  const fastest = assessed[0]?.model;
  const balance = assessed
    .filter(({ fit }) => fit.estimatedWorkingMemoryBytes <= usable * 0.6)
    .sort((a, b) => b.model.rank - a.model.rank)[0]?.model;
  const quality = [...assessed].sort((a, b) => b.model.rank - a.model.rank)[0]?.model;
  return { fastest, balance: balance ?? fastest, quality, defaultModel };
}

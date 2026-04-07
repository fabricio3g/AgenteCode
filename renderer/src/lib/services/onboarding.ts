import type { HardwareInfo } from '$lib/types/tauri';
import { invoke } from './tauri';
import { getHardwareLimits } from './hardware';
import { getRuntimeRecommendations, type RuntimeRecommendations } from './system-info';

export interface OnboardingModel {
  id: string;
  label: string;
  filename: string;
  repoId: string;
  url: string;
  sizeBytes: number;
  sizeLabel: string;
  minRamGb: number;
  recommended: boolean;
  tags: string[];
}

const MODEL_CATALOG: OnboardingModel[] = [
  {
    id: 'qwen3.5-2b-q4km',
    label: 'Qwen 3.5 2B',
    filename: 'Qwen3.5-2B-Q4_K_M.gguf',
    repoId: 'unsloth/Qwen3.5-2B-GGUF',
    url: 'https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/Qwen3.5-2B-Q4_K_M.gguf',
    sizeBytes: 1_610_612_736,
    sizeLabel: '~1.5 GB',
    minRamGb: 4,
    recommended: true,
    tags: ['fast', 'vision', 'tools'],
  },
  {
    id: 'qwen3.5-4b-q4km',
    label: 'Qwen 3.5 4B',
    filename: 'Qwen3.5-4B-Q4_K_M.gguf',
    repoId: 'unsloth/Qwen3.5-4B-GGUF',
    url: 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf',
    sizeBytes: 3_006_479_104,
    sizeLabel: '~2.8 GB',
    minRamGb: 6,
    recommended: false,
    tags: ['reasoning', 'coding', 'vision'],
  },
  {
    id: 'qwen3.5-0.8b-q4km',
    label: 'Qwen 3.5 0.8B',
    filename: 'Qwen3.5-0.8B-Q4_K_M.gguf',
    repoId: 'unsloth/Qwen3.5-0.8B-GGUF',
    url: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q4_K_M.gguf',
    sizeBytes: 643_000_000,
    sizeLabel: '~0.6 GB',
    minRamGb: 2,
    recommended: false,
    tags: ['ultra-light', 'fast'],
  },
];

export function getModelCatalog(): OnboardingModel[] {
  return MODEL_CATALOG;
}

export function getRecommendedModels(hardware: HardwareInfo | null): OnboardingModel[] {
  const ramGb = hardware?.total_ram_gb ?? 4;
  const models = MODEL_CATALOG.filter(m => m.minRamGb <= ramGb);
  // If hardware is known, promote the best fit
  if (models.length > 0) {
    const recommended = models.find(m => m.recommended);
    if (recommended) {
      return [recommended, ...models.filter(m => m.id !== recommended.id)];
    }
  }
  return models;
}

export async function checkIsFirstRun(): Promise<boolean> {
  try {
    return await invoke<boolean>('is_first_run');
  } catch {
    return false;
  }
}

export async function markOnboardingComplete(): Promise<void> {
  try {
    await invoke('update_config', {
      onboarding: { completed: true, completed_at: Date.now() },
    });
  } catch (err) {
    console.error('[onboarding] Failed to mark onboarding complete:', err);
  }
}

export interface OnboardingHardware {
  hardware: HardwareInfo | null;
  runtime: RuntimeRecommendations | null;
}

export async function gatherOnboardingHardware(): Promise<OnboardingHardware> {
  const [hardware, runtime] = await Promise.allSettled([
    getHardwareLimits(),
    getRuntimeRecommendations(),
  ]);
  return {
    hardware: hardware.status === 'fulfilled' ? hardware.value : null,
    runtime: runtime.status === 'fulfilled' ? runtime.value : null,
  };
}

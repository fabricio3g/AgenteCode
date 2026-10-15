import { assessModelFit } from '$lib/models/model-fit';
import type { HardwareInfo } from '$lib/types/bridge';

/** Whether an on-device model fits this computer, in the words the menu uses. */
export type LocalFit = 'fits' | 'tight' | 'wont' | 'unknown';

export type CardTarget =
  | { kind: 'cloud'; provider: string; providerLabel: string; model: string; name: string }
  | { kind: 'local'; name: string; sizeGb?: number; quantization?: string; context?: number; fit: LocalFit; tools?: boolean; perChat?: number | null };

export function localFit(sizeGb: number | undefined, hardware: HardwareInfo | null): LocalFit {
  if (!sizeGb || !hardware) return 'unknown';
  const { status } = assessModelFit({ artifact: { sizeBytes: sizeGb * 1024 ** 3 }, hardware });
  if (status === 'excellent' || status === 'good') return 'fits';
  if (status === 'constrained') return 'tight';
  if (status === 'unlikely') return 'wont';
  return 'unknown';
}

/** A model id as people read it: the last path part, without `.gguf`. */
export function shortModelName(value: string | null | undefined): string {
  return String(value || '').split(/[\\/]/).pop()?.replace(/\.gguf$/i, '') || '';
}

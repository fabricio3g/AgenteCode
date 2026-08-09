import type { HardwareInfo } from '$lib/types/tauri';
import { getHardwareLimits } from '$lib/services/hardware';
import { isTauri } from '$lib/services/tauri';
import { assessModelFit } from '$lib/models/model-fit';

class HardwareStore {
  info = $state<HardwareInfo | null>(null);
  loading = $state(false);
  error = $state<string | null>(null);

  get ramUsedGb(): number {
    if (!this.info) return 0;
    return this.info.total_ram_gb - this.info.free_ram_gb;
  }

  get ramUsedPercent(): number {
    if (!this.info || !this.info.total_ram_gb) return 0;
    return Math.round((this.ramUsedGb / this.info.total_ram_gb) * 100);
  }

  get hasGpu(): boolean {
    return !!this.info && this.info.vram_gb > 0;
  }

  get backendLabel(): string {
    const b = this.info?.gpu_backend;
    if (!b || b === 'cpu') return 'CPU only';
    return b.toUpperCase();
  }

  /** Estimate if model of given size (GB) fits in VRAM: green/yellow/red */
  modelVramFit(modelSizeGb: number): 'vram' | 'partial' | 'ram' | 'unknown' {
    const fit = assessModelFit({
      artifact: { sizeBytes: Math.max(0, modelSizeGb) * 1024 ** 3 },
      hardware: this.info,
    });
    if (fit.status === 'unknown') return 'unknown';
    if (fit.offload === 'full_gpu') return 'vram';
    if (fit.offload === 'partial_gpu') return 'partial';
    return 'ram';
  }

  async refresh() {
    if (!isTauri()) return;
    this.loading = true;
    this.error = null;
    try {
      this.info = await getHardwareLimits();
    } catch (err: unknown) {
      this.error = String((err as Error)?.message || err || 'Failed to get hardware info');
    } finally {
      this.loading = false;
    }
  }
}

export const hardwareStore = new HardwareStore();

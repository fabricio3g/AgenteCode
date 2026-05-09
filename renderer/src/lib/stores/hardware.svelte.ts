import type { HardwareInfo } from '$lib/types/tauri';
import { getHardwareLimits } from '$lib/services/hardware';
import { isTauri } from '$lib/services/tauri';

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
    if (!this.info) return 'unknown';
    if (this.info.vram_gb <= 0) return 'ram';
    const effective = this.info.vram_gb * 0.85;
    if (modelSizeGb <= effective) return 'vram';
    if (modelSizeGb <= this.info.vram_gb * 1.4) return 'partial';
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

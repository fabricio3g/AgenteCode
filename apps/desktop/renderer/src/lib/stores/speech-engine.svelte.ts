// The local voice engine (bundled audio.cpp) and its voice models, as one
// reactive object shared by Settings → Voice, Settings → On this computer and
// the setup wizard. Downloads go through the app's downloader, so their
// progress lives in downloadsStore; this store only knows what is installed,
// what the catalog offers and whether a model fits this computer.

import { invoke } from '$lib/services/bridge';
import { restartSpeechEngine, speechEngineStatus, type SpeechEngineStatus } from '$lib/services/speech-engine';
import { appStore } from '$lib/stores/app.svelte';
import { downloadsStore } from '$lib/stores/downloads.svelte';
import { hardwareStore } from '$lib/stores/hardware.svelte';
import { VOICE_MODELS, voiceModelFiles, type VoiceModel } from '$shared/voice-models';

type VoiceModelState = 'installed' | 'downloading' | 'failed' | 'available';

/**
 * Whether a model runs here. Speech models are small next to chat models, so
 * the check is coarse: weights plus working memory against what is free.
 * - `good`: fits the graphics card (Vulkan), or uses under a third of the RAM
 * - `slow`: fits in RAM, but leaves little room or runs on the CPU only
 * - `no`: needs more memory than this computer has
 * - `unknown`: no size or no hardware reading yet
 */
export type VoiceModelFit = 'good' | 'slow' | 'no' | 'unknown';

class SpeechEngineStore {
  status = $state<SpeechEngineStatus | null>(null);
  /** Every model the engine can run; starts with the featured pair until the catalog arrives. */
  models = $state<VoiceModel[]>(VOICE_MODELS);
  loading = $state(false);
  #catalogLoaded = false;

  /** The engine ships with this build (at least one backend is bundled). */
  get bundled(): boolean {
    return !!this.status?.backends.length;
  }

  find(id: string | undefined): VoiceModel | undefined {
    return id ? this.models.find((model) => model.id === id) : undefined;
  }

  /** The model replies are read with: the chosen one if installed, else the first installed. */
  get active(): VoiceModel | null {
    const installed = this.status?.installed ?? [];
    const chosen = this.find(appStore.config.tts?.voice_model);
    if (chosen && installed.includes(chosen.id)) return chosen;
    return this.models.find((model) => installed.includes(model.id)) ?? null;
  }

  async refresh(): Promise<void> {
    this.loading = true;
    try {
      const [status, catalog] = await Promise.all([
        speechEngineStatus(),
        this.#catalogLoaded ? Promise.resolve(null) : invoke<VoiceModel[]>('voice_catalog').catch(() => null)
      ]);
      this.status = status;
      if (catalog?.length) {
        this.models = catalog;
        this.#catalogLoaded = true;
      }
      if (!hardwareStore.info && !hardwareStore.loading) void hardwareStore.refresh();
    } finally {
      this.loading = false;
    }
  }

  jobs(model: VoiceModel) {
    return voiceModelFiles(model).map((file) => downloadsStore.jobFor(model.repo, file)).filter((job) => !!job);
  }

  /** The first file's job, for callers that only need "is there a download". */
  job(model: VoiceModel) {
    return this.jobs(model)[0];
  }

  state(model: VoiceModel): VoiceModelState {
    if (this.status?.installed.includes(model.id)) return 'installed';
    const jobs = this.jobs(model);
    if (jobs.some((job) => ['queued', 'running'].includes(job.status))) return 'downloading';
    if (jobs.some((job) => ['error', 'interrupted'].includes(job.status))) return 'failed';
    return 'available';
  }

  progress(model: VoiceModel): number {
    const files = voiceModelFiles(model);
    const jobs = this.jobs(model);
    const done = jobs.reduce((sum, job) => sum + (job.status === 'completed' ? 100 : Number(job.progress ?? 0)), 0);
    return Math.round(done / Math.max(1, files.length));
  }

  /** Every file finished downloading (the main process may not have seen it yet). */
  downloaded(model: VoiceModel): boolean {
    const jobs = this.jobs(model);
    return jobs.length === voiceModelFiles(model).length && jobs.every((job) => job.status === 'completed');
  }

  fit(model: VoiceModel): VoiceModelFit {
    const hw = hardwareStore.info;
    if (!hw || !model.sizeMb) return 'unknown';
    // Weights plus activations and the codec: about 1.5× the file, plus a floor.
    const needGb = (model.sizeMb * 1.5 + 400) / 1024;
    const vulkan = this.status?.backend === 'vulkan' && hw.vram_gb > 0;
    if (vulkan && needGb <= hw.vram_gb * 0.9) return 'good';
    if (needGb > hw.total_ram_gb * 0.8) return 'no';
    return needGb <= hw.total_ram_gb / 3 ? (vulkan || model.sizeMb < 600 ? 'good' : 'slow') : 'slow';
  }

  async download(model: VoiceModel): Promise<void> {
    for (const job of this.jobs(model)) {
      if (['error', 'interrupted', 'cancelled'].includes(job.status)) await downloadsStore.removeJob(job.id).catch(() => {});
    }
    await invoke('voice_model_download', { id: model.id });
    downloadsStore.startPolling();
    await downloadsStore.refresh();
  }

  async remove(model: VoiceModel): Promise<void> {
    await invoke('voice_model_delete', { id: model.id });
    await this.refresh();
  }

  /** Make a model the one replies are read with, keeping the language when it can. */
  async use(model: VoiceModel): Promise<void> {
    const tts = appStore.config.tts ?? {};
    const language = model.languages.includes(tts.language ?? '') ? tts.language! : model.languages[0];
    const voice = model.voices.find((option) => option.id === tts.voice)?.id
      ?? model.voices.find((option) => option.language === '*' || option.language === language)?.id;
    await appStore.updateTtsSettings({ voice_model: model.id, language, voice });
  }

  /** Change how the engine runs and restart it so the change applies at once. */
  async configure(patch: { local_backend?: 'cpu' | 'vulkan'; num_threads?: number }): Promise<void> {
    await appStore.updateTtsSettings(patch);
    await restartSpeechEngine();
    await this.refresh();
  }
}

export const speechEngine = new SpeechEngineStore();

import type { CachedModelMeta, LocalModel, SupervisorStatus } from '$lib/types/tauri';
import { getIndexedModels, getLocalModels, refreshModelIndex } from '$lib/services/models';
import { getSupervisorStatus } from '$lib/services/runtime';
import { isTauri } from '$lib/services/tauri';

class ModelsStore {
  indexedModels = $state<CachedModelMeta[]>([]);
  fallbackModels = $state<LocalModel[]>([]);
  loading = $state(false);
  status = $state<SupervisorStatus | null>(null);
  error = $state<string | null>(null);
  unloading = $state(false);
  lastRefresh = $state<number>(0);
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  get availableModels() {
    if (this.indexedModels.length) {
      return this.indexedModels.map((model) => ({
        id: model.id,
        name: model.name,
        path: model.path,
        size_gb: model.size_gb,
        modified: model.modified_time,
        architecture: model.architecture,
        context_length: model.context_length,
        parameter_count: model.parameter_count,
        size_label: model.size_label,
        quantization_name: model.quantization_name,
        block_count: model.block_count,
        chat_template_uses_tools: model.chat_template_uses_tools,
        source: 'indexed' as const
      }));
    }

    return this.fallbackModels.map((model) => ({
      ...model,
      source: 'filesystem' as const
    }));
  }

  get statusLabel() {
    const state = this.status?.state;
    if (!state) return 'Unavailable';
    if (typeof state === 'string') {
      return state.replace(/_/g, ' ');
    }
    if (typeof state === 'object' && 'Error' in state) {
      return 'error';
    }
    return String(state);
  }

  get activePort() {
    return this.status?.port ?? null;
  }

  get hasActiveModel() {
    return Boolean(this.status?.active_model);
  }

  get activeModelName() {
    const active = this.status?.active_model;
    if (!active) return null;
    return String(active).split('/').pop()?.split('\\').pop() || active;
  }

  async refresh() {
    if (!isTauri()) {
      this.indexedModels = [];
      this.fallbackModels = [];
      this.status = null;
      return;
    }

    this.loading = true;
    this.error = null;

    try {
      await refreshModelIndex();
    } catch {
      // keep going with cached state
    }

    try {
      this.indexedModels = await getIndexedModels();
    } catch (error) {
      this.indexedModels = [];
      this.error = String((error as Error)?.message || error || 'Failed to load indexed models');
    }

    if (!this.indexedModels.length) {
      try {
        this.fallbackModels = await getLocalModels();
      } catch (error) {
        this.fallbackModels = [];
        this.error = String((error as Error)?.message || error || 'Failed to load local models');
      }
    } else {
      this.fallbackModels = [];
    }

    try {
      this.status = await getSupervisorStatus();
    } catch {
      this.status = null;
    }

    this.loading = false;
    this.lastRefresh = Date.now();
  }

  async refreshStatus() {
    if (!isTauri()) return;
    try {
      this.status = await getSupervisorStatus();
    } catch {
      this.status = null;
    }
  }

  setUnloading(value: boolean) {
    this.unloading = value;
  }

  clearError() {
    this.error = null;
  }

  startPolling(intervalMs = 3000) {
    if (this.pollInterval) return;
    this.pollInterval = setInterval(() => {
      void this.refreshStatus();
    }, intervalMs);
  }

  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }
}

export const modelsStore = new ModelsStore();

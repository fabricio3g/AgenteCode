import type { CachedModelMeta, LocalModel, SupervisorEvent, SupervisorStatus } from '$lib/types/bridge';
import { getIndexedModels, getLocalModels, refreshModelIndex } from '$lib/services/models';
import { getSupervisorStatus, onSupervisorEvent } from '$lib/services/runtime';
import { isElectron } from '$lib/services/bridge';

class ModelsStore {
  indexedModels = $state<CachedModelMeta[]>([]);
  fallbackModels = $state<LocalModel[]>([]);
  loading = $state(false);
  status = $state<SupervisorStatus | null>(null);
  error = $state<string | null>(null);
  unloading = $state(false);
  lastRefresh = $state<number>(0);
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private idleCount = 0;
  private eventUnlisten: (() => void) | null = null;
  private eventInitialized = false;

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
    return String(active).split(/[\\/]/).pop() || active;
  }

  async refresh() {
    if (!isElectron()) {
      this.indexedModels = [];
      this.fallbackModels = [];
      this.status = null;
      return;
    }
    await this.refreshIndex();
    await this.refreshStatus();
  }

  async refreshIndex() {
    if (!isElectron()) {
      this.indexedModels = [];
      this.fallbackModels = [];
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

    this.loading = false;
    this.lastRefresh = Date.now();
  }

  async refreshStatus() {
    if (!isElectron()) return;
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

  async initPushEvents() {
    if (this.eventInitialized || !isElectron()) return;
    this.eventInitialized = true;
    try {
      this.eventUnlisten = await onSupervisorEvent((event: SupervisorEvent) => {
        if (event.type === 'state_change') {
          const stateEvent = event as SupervisorEvent & {
            state?: unknown;
            to?: unknown;
            model_id?: unknown;
            model_path?: unknown;
          };
          this.status = {
            state: typeof stateEvent.state === 'string'
              ? stateEvent.state
              : (typeof stateEvent.to === 'string' ? stateEvent.to : 'idle'),
            active_model: typeof stateEvent.model_id === 'string'
              ? stateEvent.model_id
              : (typeof stateEvent.model_path === 'string' ? stateEvent.model_path : null),
            port: event.port ?? null,
            uptime_secs: null,
            memory_mb: null,
            sessions_count: this.status?.sessions_count ?? 0
          };
        }
      });
    } catch {
      this.eventInitialized = false;
    }
  }

  destroyPushEvents() {
    if (this.eventUnlisten) {
      this.eventUnlisten();
      this.eventUnlisten = null;
      this.eventInitialized = false;
    }
  }

  startPolling(intervalMs = 3000) {
    if (this.eventInitialized) return;
    if (this.pollInterval) {
      // Reset idle counter when explicitly restarting
      this.idleCount = 0;
      return;
    }
    this.idleCount = 0;
    this.pollInterval = setInterval(() => {
      void this.refreshStatus();
      // Auto-stop polling after 2 consecutive idle/error checks
      const state = this.status?.state;
      if (state === 'idle' || state === 'error' || !state) {
        this.idleCount++;
        if (this.idleCount >= 2) {
          this.stopPolling();
        }
      } else {
        this.idleCount = 0;
      }
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

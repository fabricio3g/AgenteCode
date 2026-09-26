/**
 * Running local models: the main one plus extra instances started next to it
 * (Models → Running, and the sidebar's "Running" list).
 */
import { invoke, isElectron, listen } from '$lib/services/bridge';
import { appStore } from '$lib/stores/app.svelte';

export type LocalInstance = {
  id: string;
  main: boolean;
  model_id: string;
  model_path: string;
  state: string;
  error: string | null;
  port: number | null;
  shared: boolean;
  lan_url: string | null;
  local_url: string | null;
  parallel: number;
  context: number | null;
  started_at: number | null;
};

const DEFAULT_LOCAL_PORT = 11435;

function portOf(url: string | undefined | null): number | null {
  try {
    return Number(new URL(String(url || '')).port) || null;
  } catch {
    return null;
  }
}

class InstancesStore {
  list = $state<LocalInstance[]>([]);
  lanAddress = $state<string | null>(null);
  private listening = false;

  /** The instance chat talks to: whichever port `llm.local.base_url` points at. */
  get chatPort(): number {
    return portOf(appStore.config.llm?.local?.base_url) ?? DEFAULT_LOCAL_PORT;
  }

  inChat(instance: LocalInstance): boolean {
    return appStore.backendMode === 'local' && instance.port === this.chatPort;
  }

  get running(): LocalInstance[] {
    return this.list.filter((instance) => instance.state !== 'idle');
  }

  /**
   * Chat points at an extra instance that is up: make sure the app treats
   * that as a loaded model (it only tracks the main one on its own).
   */
  private syncChat(): void {
    const target = this.list.find((instance) => !instance.main && this.inChat(instance) && instance.state === 'ready');
    if (target && appStore.localModelActive?.path !== target.model_path) {
      appStore.localModelActive = { name: target.model_id.replace(/\.gguf$/i, ''), path: target.model_path, hasMmproj: false };
    }
  }

  async refresh(): Promise<void> {
    if (!isElectron()) return;
    try {
      const result = await invoke<{ instances: LocalInstance[]; lan_address: string | null }>('list_instances');
      this.list = result.instances;
      this.lanAddress = result.lan_address;
      this.syncChat();
    } catch {
      this.list = [];
    }
  }

  /** Keep the list live: extra instances report changes, the main one via supervisor events. */
  async watch(): Promise<void> {
    if (this.listening || !isElectron()) return;
    this.listening = true;
    await listen<LocalInstance[]>('instances-changed', (list) => { if (Array.isArray(list)) { this.list = list; this.syncChat(); } });
    await listen('supervisor-event', () => void this.refresh());
    await this.refresh();
  }

  async start(options: { model_path: string; parallel: number; context_length: number; share: boolean }): Promise<void> {
    this.list = await invoke<LocalInstance[]>('start_instance', options);
  }

  async stop(id: string): Promise<void> {
    const stopped = this.list.find((instance) => instance.id === id);
    const wasChat = !!stopped && !stopped.main && this.inChat(stopped);
    this.list = await invoke<LocalInstance[]>('stop_instance', { id });
    // Chat was using it: hand chat back to the main model (or to nothing).
    if (wasChat) {
      const main = this.list.find((instance) => instance.main);
      await appStore.useLocalInstance(main?.local_url ? { name: main.model_id, path: main.model_path, base_url: main.local_url } : null);
    }
  }

  async share(id: string, share: boolean): Promise<void> {
    this.list = await invoke<LocalInstance[]>('set_instance_sharing', { id, share });
  }

  key(id: string): Promise<string> {
    return invoke<string>('get_instance_key', { id });
  }

  /** Point chat at this instance. */
  async useInChat(instance: LocalInstance): Promise<void> {
    if (!instance.local_url) return;
    await appStore.useLocalInstance({ name: instance.model_id.replace(/\.gguf$/i, ''), path: instance.model_path, base_url: instance.local_url });
  }
}

export const instancesStore = new InstancesStore();

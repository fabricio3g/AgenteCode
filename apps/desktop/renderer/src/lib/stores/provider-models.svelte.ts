// The models each configured cloud provider offers, loaded once and shared by
// every picker (the composer's ModelSwitcher, a bot's model pin). A list is
// seeded instantly from what the app already knows, so a picker never sits on
// an empty loader; the provider is asked only when it can answer.

import { get } from 'svelte/store';
import { t } from 'svelte-i18n';
import { appStore } from '$lib/stores/app.svelte';
import { invoke } from '$lib/services/bridge';
import type { ModelOption } from '$lib/types/chat';
import { defaultBaseUrl } from '$lib/utils/providers';

const TIMEOUT_MS = 12_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

class ProviderModelsStore {
  /** Models per provider id; `undefined` = not asked yet. */
  byProvider = $state<Record<string, ModelOption[] | undefined>>({});
  loading = $state<Record<string, boolean>>({});
  errors = $state<Record<string, string>>({});

  /** What the app already knows about `id`: the active list, or the saved model. */
  seed(id: string): ModelOption[] {
    if (id === appStore.activeProviderName && appStore.models.length) return appStore.models.slice();
    const saved = appStore.config.llm?.providers?.[id];
    return saved?.model ? [{ id: String(saved.model), name: String(saved.model), source: 'api' as const }] : [];
  }

  /** The loaded list, or the seed until it arrives. */
  models(id: string): ModelOption[] {
    return this.byProvider[id] ?? this.seed(id);
  }

  async load(id: string, force = false): Promise<void> {
    if (this.loading[id]) return;
    if (!force && this.byProvider[id] !== undefined) return;

    const seeded = this.seed(id);
    if (seeded.length && this.byProvider[id] === undefined) this.byProvider = { ...this.byProvider, [id]: seeded };

    const saved = appStore.config.llm?.providers?.[id];
    const baseUrl = saved?.base_url || defaultBaseUrl(id);
    // A provider with no key can't list models, and asking anyway makes the
    // main process log a handler error on every start. Keyless local runtimes
    // (llama.cpp, Ollama, LM Studio) are still asked.
    const hasKey = !!(saved?.has_api_key || saved?.api_key);
    const isLocal = id === 'local' || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(baseUrl);
    if (!hasKey && !isLocal) return;

    this.loading = { ...this.loading, [id]: true };
    this.errors = { ...this.errors, [id]: '' };
    try {
      // An empty key: the main process uses the one stored for the provider.
      const ids = await withTimeout(invoke<string[]>('fetch_provider_models', { baseUrl, apiKey: '', providerName: id }), TIMEOUT_MS);
      const unique = [...new Set((Array.isArray(ids) ? ids : []).filter((mid) => typeof mid === 'string' && mid.trim()))];
      const list = unique.map((mid) => ({ id: String(mid), name: String(mid), source: 'api' as const }));
      this.byProvider = { ...this.byProvider, [id]: list.length ? list : this.seed(id) };
    } catch {
      this.errors = { ...this.errors, [id]: get(t)('modelPicker.refreshFailed') };
      // Keep the seed or the previous list: never an empty loader.
      if (this.byProvider[id] === undefined) this.byProvider = { ...this.byProvider, [id]: this.seed(id) };
    } finally {
      this.loading = { ...this.loading, [id]: false };
    }
  }
}

export const providerModels = new ProviderModelsStore();

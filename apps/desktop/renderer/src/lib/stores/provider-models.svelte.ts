// The models each configured cloud provider offers, shared by
// every picker (the composer's ModelSwitcher, a bot's model pin). A list is
// seeded instantly from what the app already knows, so a picker never sits on
// an empty loader; the provider is asked only when it can answer.

import { get } from 'svelte/store';
import { t } from 'svelte-i18n';
import { appStore } from '$lib/stores/app.svelte';
import { cachedModels, fetchModels } from '$lib/services/chat-api';
import type { AppConfig, ModelOption } from '$lib/types/chat';
import { defaultBaseUrl } from '$lib/utils/providers';

export class ProviderModelsStore {
  private loaded = new Map<string, { route: string; list: ModelOption[] }>();
  private pending = new Map<string, { route: string; force: boolean; promise: Promise<void> }>();

  private request(id: string): { config: AppConfig; route: string } {
    const current = appStore.config;
    const saved = current.llm?.providers?.[id];
    const baseUrl = saved?.base_url || defaultBaseUrl(id);
    return {
      route: JSON.stringify([id, baseUrl.replace(/\/+$/, ''), saved?.api_key || '', !!saved?.has_api_key]),
      config: { ...current, llm: { ...current.llm, provider: id,
        providers: { ...current.llm?.providers, [id]: { ...saved, model: saved?.model || '', base_url: baseUrl } } } }
    };
  }
  /** Models per provider id; `undefined` = not asked yet. */
  byProvider = $state<Record<string, ModelOption[] | undefined>>({});
  loading = $state<Record<string, boolean>>({});
  errors = $state<Record<string, string>>({});

  /** A saved choice seeds the picker until its first successful API response. */
  seed(id: string): ModelOption[] {
    const saved = appStore.config.llm?.providers?.[id];
    return saved?.model ? [{ id: String(saved.model), name: String(saved.model), source: 'api' as const }] : [];
  }

  /** The loaded list, or the seed until it arrives. */
  models(id: string): ModelOption[] {
    const list = this.byProvider[id];
    return this.loaded.get(id)?.route === this.request(id).route ? list ?? [] : this.seed(id);
  }

  load(id: string, force = false): Promise<void> {
    const { config, route } = this.request(id);
    const current = this.pending.get(id);
    if (current?.route === route && (!force || current.force)) return current.promise;
    const cached = cachedModels(config);
    const loaded = this.loaded.get(id);
    if (!force && cached && loaded?.route === route && loaded.list === cached) return Promise.resolve();

    const saved = config.llm?.providers?.[id];
    const baseUrl = saved?.base_url || '';
    const hasKey = !!(saved?.has_api_key || saved?.api_key);
    const isLocal = id === 'local' || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(baseUrl);
    if (!hasKey && !isLocal) return Promise.resolve();

    this.loading = { ...this.loading, [id]: true };
    this.errors = { ...this.errors, [id]: '' };
    const request = { route, force, promise: Promise.resolve() };
    this.pending.set(id, request);
    request.promise = fetchModels(config, undefined, force).then(list => {
      if (this.pending.get(id) !== request) return;
      this.loaded.set(id, { route, list });
      // Successful lists replace the snapshot, including an empty list.
      this.byProvider = { ...this.byProvider, [id]: list };
    }).catch(() => {
      if (this.pending.get(id) === request) {
        this.errors = { ...this.errors, [id]: get(t)('modelPicker.refreshFailed') };
      }
    }).finally(() => {
      if (this.pending.get(id) === request) {
        this.pending.delete(id);
        this.loading = { ...this.loading, [id]: false };
      }
    });
    return request.promise;
  }
}

export const providerModels = new ProviderModelsStore();

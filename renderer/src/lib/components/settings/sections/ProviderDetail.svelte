<svelte:options runes={true} />

<!--
  One provider's full-page detail (Jan grammar):

  Header carries the colored mark and the enable toggle — ON means "this is
  the route chats use" and persists any pending draft in the same gesture.
  Below: the API key block, the model roster as rows (activate / add / remove,
  with hand-added ids persisted as extra_models), and Advanced sampling under
  a disclosure. Field edits save without switching the active provider;
  activation belongs to the toggle alone.

  Outside Electron the model roster falls back to a direct GET {base}/models,
  which keeps dev-in-browser and local-server setups working.
-->

<script lang="ts">
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { copy } from '$lib/copy';
  import { untrack } from 'svelte';
  import { Check, LoaderCircle, Plus, RefreshCw, Trash2, X } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { invoke, isElectron } from '$lib/services/bridge';
  import { CLOUD_PROVIDERS, PROVIDER_DOCS, defaultBaseUrl, isProviderConfigured } from '$lib/utils/providers';
  import ProviderIcon from '$lib/components/ui/ProviderIcon.svelte';

  let { providerId }: { providerId: string } = $props();

  // ── Directory ────────────────────────────────────────────────────────
  const builtIn = $derived(CLOUD_PROVIDERS.find((p) => p.id === providerId));
  const customEntry = $derived(appStore.config.llm?.custom_providers?.find((p) => p.id === providerId));
  const label = $derived(builtIn?.label ?? customEntry?.label ?? providerId);
  const isRemovable = $derived(!!(customEntry ?? providerId.startsWith('custom')));

  const saved = $derived(appStore.config.llm?.providers?.[providerId]);
  const isActiveProvider = $derived(
    appStore.backendMode === 'api' && appStore.activeProviderName === providerId && !!appStore.activeProviderName
  );

  // ── Draft ────────────────────────────────────────────────────────────
  interface DetailDraft {
    baseUrl: string;
    apiKey: string;
    temperature: number;
    topP: number;
    maxTokens: string;
    systemPrompt: string;
  }

  // Rebuilt by the providerId effect below; this only seeds the first render.
  let draft = $state<DetailDraft>(untrack(() => buildDraft(providerId)));

  function buildDraft(id: string): DetailDraft {
    const savedProvider = appStore.config.llm?.providers?.[id];
    return {
      baseUrl: savedProvider?.base_url || customBaseOf(id) || builtIn?.defaultBaseUrl || defaultBaseUrl(id),
      apiKey: '',
      temperature: Number(savedProvider?.temperature ?? 0.7),
      topP: Number(savedProvider?.top_p ?? 0.95),
      maxTokens: String(savedProvider?.max_tokens ?? ''),
      systemPrompt: savedProvider?.system_prompt ?? ''
    };
  }

  function customBaseOf(id: string): string {
    return appStore.config.llm?.custom_providers?.find((p) => p.id === id)?.base_url ?? '';
  }

  $effect(() => {
    // Switching providers rebuilds the draft; the password field never
    // round-trips a stored key. Config commits must NOT reset the form,
    // so only the provider id is tracked here.
    const id = providerId;
    untrack(() => {
      draft = buildDraft(id);
      modelFetch.fetched = [];
      modelFetch.error = '';
      modelFetch.loaded = false;
      void loadModels();
    });
  });

  const keyDirty = $derived(draft.apiKey.trim().length > 0);
  const baseDirty = $derived(draft.baseUrl !== (saved?.base_url || customBaseOf(providerId) || builtIn?.defaultBaseUrl || defaultBaseUrl(providerId)));

  type ProviderFields = Omit<Parameters<typeof appStore.updateProvider>[0], 'provider'>;

  async function persistFields(fields: ProviderFields) {
    await appStore.updateProvider({ provider: providerId, ...fields }, { activate: false });
  }

  async function saveKey() {
    if (!keyDirty) return;
    await persistFields({ api_key: draft.apiKey.trim() });
    draft.apiKey = '';
    toastStore.success('API key saved');
  }

  async function saveBaseUrl() {
    if (!baseDirty || !draft.baseUrl.trim()) return;
    await persistFields({ base_url: draft.baseUrl.trim() });
    toastStore.success('Base URL saved');
  }

  async function saveSampling() {
    await persistFields({
      temperature: draft.temperature,
      top_p: draft.topP,
      max_tokens: draft.maxTokens ? parseInt(draft.maxTokens) : undefined,
      system_prompt: draft.systemPrompt || undefined
    });
  }

  // ── Activation toggle ────────────────────────────────────────────────
  async function toggleActive(on: boolean) {
    try {
      if (on) {
        // One gesture: persist whatever the user typed, switch to API mode,
        // and make this the route chats use.
        const fields: ProviderFields = {
          base_url: draft.baseUrl.trim(),
          model: saved?.model || ''
        };
        if (keyDirty) {
          fields.api_key = draft.apiKey.trim();
          draft.apiKey = '';
        }
        await appStore.setBackendMode('api');
        await appStore.updateProvider({ provider: providerId, ...fields });
        toastStore.success(`${label} activated`);
      } else {
        await appStore.setActiveProvider('');
        toastStore.info(`${label} deactivated`);
      }
    } catch (err) {
      toastStore.error((err as Error)?.message || String(err));
    }
  }

  // ── Models roster ────────────────────────────────────────────────────
  const modelFetch = $state({ fetched: [] as string[], loading: false, error: '', loaded: false });

  const extraModels = $derived(saved?.extra_models ?? []);
  /** Roster order: active first, then fetched, then hand-added ids. */
  const roster = $derived.by(() => {
    const seen = new Set<string>();
    const list: Array<{ id: string; added: boolean }> = [];
    for (const id of [saved?.model, ...modelFetch.fetched, ...extraModels]) {
      const value = String(id || '').trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      list.push({ id: value, added: extraModels.includes(value) });
    }
    return list;
  });

  async function loadModels(force = false) {
    if (modelFetch.loading) return;
    const needsNoKey = builtIn?.group === 'local';
    if (!force && modelFetch.loaded) return;
    if (!isProviderConfigured(appStore.config, providerId) && !needsNoKey && !draft.apiKey.trim() && !isElectron()) {
      return; // nothing to authenticate with yet
    }
    modelFetch.loading = true;
    modelFetch.error = '';
    try {
      const key = draft.apiKey.trim() || undefined;
      modelFetch.fetched = await invoke<string[]>('fetch_provider_models', {
        baseUrl: draft.baseUrl,
        apiKey: key,
        providerName: providerId
      });
      modelFetch.loaded = true;
    } catch (err) {
      if (!isElectron()) {
        // Browser/dev mode: hit the endpoint directly (OpenRouter and local
        // gateways are CORS-open).
        try {
          const res = await fetch(`${draft.baseUrl.replace(/\/+$/, '')}/models`, {
            headers: {
              Accept: 'application/json',
              ...(draft.apiKey.trim() ? { Authorization: `Bearer ${draft.apiKey.trim()}` } : {})
            }
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          const list = data?.data ?? data?.models ?? [];
          modelFetch.fetched = list.map((m: { id?: string }) => String(m?.id || '')).filter(Boolean);
          modelFetch.loaded = true;
        } catch (directErr) {
          modelFetch.error = (directErr as Error)?.message || String(directErr);
        }
      } else {
        modelFetch.error = (err as Error)?.message || String(err);
      }
    } finally {
      modelFetch.loading = false;
    }
  }

  async function activateModel(id: string) {
    await persistFields({ model: id });
    toastStore.success(`Model set to ${id}`);
  }

  let addingModel = $state(false);
  let newModelId = $state('');

  async function addExtraModel() {
    const id = newModelId.trim();
    if (!id) return;
    if (roster.some((entry) => entry.id === id)) {
      toastStore.info('That model is already in the list');
      return;
    }
    await persistFields({ extra_models: [...extraModels, id] });
    newModelId = '';
    addingModel = false;
  }

  async function removeExtraModel(id: string) {
    await persistFields({ extra_models: extraModels.filter((m) => m !== id) });
  }

  // ── Custom-endpoint removal ──────────────────────────────────────────
  async function removeEndpoint() {
    const accepted = await confirmStore.ask({
      title: `Remove ${label}?`,
      message: 'Its saved API key and model list are deleted from Flaxeo.',
      confirmLabel: copy.actions.remove,
      danger: true
    });
    if (!accepted) return;
    try {
      await appStore.removeCustomProvider(providerId);
      toastStore.success('Endpoint removed');
    } catch (err) {
      toastStore.error('Failed to remove: ' + ((err as Error)?.message || String(err)));
    }
  }
</script>

<div class="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
  <div class="flex-1 overflow-y-auto">
    <div class="mx-auto max-w-[720px] space-y-6 p-5 sm:p-6">
      <!-- Header -->
      <header class="flex items-center justify-between gap-3">
        <div class="flex min-w-0 items-center gap-3">
          <span class="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-card text-foreground">
            <ProviderIcon provider={providerId} size={24} />
          </span>
          <div class="min-w-0">
            <h3 class="truncate text-lg font-semibold tracking-[-0.02em] text-foreground">{label}</h3>
            {#if PROVIDER_DOCS[providerId]}
              <a href={PROVIDER_DOCS[providerId]} target="_blank" rel="noreferrer" class="text-xs text-muted-foreground hover:text-foreground hover:underline">Official API documentation ↗</a>
            {/if}
            {#if isRemovable}
              <p class="text-xs text-muted-foreground">Custom OpenAI-compatible endpoint</p>
            {/if}
          </div>
        </div>

        <!-- Enable toggle: ON persists the draft and routes chats here. -->
        <button
          type="button"
          role="switch"
          aria-checked={isActiveProvider}
          aria-label={`${label} active`}
          class="relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200 {isActiveProvider ? 'bg-[var(--success)]' : 'bg-[var(--surface-hover)]'}"
          onclick={() => void toggleActive(!isActiveProvider)}
        >
          <span
            class="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 {isActiveProvider ? 'translate-x-5' : ''}"
          ></span>
        </button>
      </header>

      <!-- API key -->
      <section class="space-y-2 rounded-xl border border-border bg-muted/30 px-4 py-3.5">
        <h4 class="text-sm font-semibold text-foreground">API keys</h4>
        <p class="text-xs leading-relaxed text-muted-foreground">
          Enter your API key. It is stored locally and sent only to {label}.
        </p>
        <input
          class="aui-input w-full"
          type="password"
          bind:value={draft.apiKey}
          placeholder={saved?.has_api_key ? '••••••••••••  (saved — leave blank to keep)' : 'Paste API key…'}
          onkeydown={(e) => { if (e.key === 'Enter') void saveKey(); }}
        />
        <div class="flex items-center justify-between">
          <button
            type="button"
            class="rounded-full border border-border px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:opacity-40"
            onclick={() => void saveKey()}
            disabled={!keyDirty}
          >
            Save key
          </button>
          {#if saved?.has_api_key}
            <span class="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--text-secondary)]">
              <span class="h-1.5 w-1.5 rounded-full bg-[var(--success)]"></span> Key saved
            </span>
          {/if}
        </div>

        <label class="block space-y-1.5 pt-1">
          <span class="text-xs font-medium text-[var(--text-secondary)]">Base URL</span>
          <input
            class="aui-input w-full"
            bind:value={draft.baseUrl}
            placeholder={builtIn?.defaultBaseUrl || 'https://api.example.com/v1'}
            onkeydown={(e) => { if (e.key === 'Enter') void saveBaseUrl(); }}
            onchange={() => void saveBaseUrl()}
          />
        </label>
      </section>

      <!-- Models -->
      <section class="space-y-2 rounded-xl border border-border bg-muted/30 px-4 py-3.5">
        <div class="flex items-center justify-between gap-2">
          <h4 class="text-sm font-semibold text-foreground">Models</h4>
          <div class="flex items-center gap-1">
            <button
              type="button"
              class="aui-icon-button size-7"
              onclick={() => void loadModels(true)}
              disabled={modelFetch.loading}
              title="Refresh model list"
              aria-label="Refresh model list"
            >
              {#if modelFetch.loading}
                <LoaderCircle class="size-3.5 animate-spin" />
              {:else}
                <RefreshCw class="size-3.5" />
              {/if}
            </button>
            <button
              type="button"
              class="aui-icon-button size-7"
              onclick={() => { addingModel = !addingModel; }}
              title="Add a model id"
              aria-label="Add a model id"
            >
              {#if addingModel}<X class="size-3.5" />{:else}<Plus class="size-3.5" />{/if}
            </button>
          </div>
        </div>

        {#if addingModel}
          <div class="flex gap-2">
            <input
              class="aui-input flex-1"
              bind:value={newModelId}
              placeholder="provider/model-id"
              onkeydown={(e) => { if (e.key === 'Enter') void addExtraModel(); }}
            />
            <button
              type="button"
              class="rounded-full bg-[var(--primary)] px-3 py-1.5 text-xs font-semibold text-[var(--primary-fg)] disabled:opacity-50"
              onclick={() => void addExtraModel()}
              disabled={!newModelId.trim()}
            >Add</button>
          </div>
        {/if}

        {#if modelFetch.error}
          <p class="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{modelFetch.error}</p>
        {/if}

        {#if roster.length === 0 && !modelFetch.loading}
          <p class="px-1 py-3 text-xs text-muted-foreground">
            No models listed yet. Paste your API key above, then refresh — or add a model id by hand with +.
          </p>
        {:else}
          <ul class="divide-y divide-[var(--border-subtle)] overflow-hidden rounded-lg border border-border bg-[var(--background)]">
            {#each roster as entry (entry.id)}
              {@const active = saved?.model === entry.id}
              <li class="flex items-center gap-2 px-3 py-2 {active ? 'bg-muted/50' : ''}">
                <span class="min-w-0 flex-1 truncate text-sm {active ? 'font-semibold text-foreground' : 'text-[var(--text-secondary)]'}" title={entry.id}>
                  {entry.id}
                </span>
                {#if entry.added}
                  <span class="rounded-full bg-[var(--surface-hover)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-muted)]">added</span>
                {/if}
                <button
                  type="button"
                  class="flex size-6 shrink-0 items-center justify-center rounded-full transition {active
                    ? 'bg-[var(--success)]/15 text-[var(--success)]'
                    : 'text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]'}"
                  title={active ? 'Active model' : 'Use this model'}
                  aria-label={active ? 'Active model' : `Use ${entry.id}`}
                  onclick={() => void activateModel(entry.id)}
                >
                  <Check class="size-3.5" />
                </button>
                {#if entry.added}
                  <button
                    type="button"
                    class="flex size-6 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--error)]"
                    title="Remove from list"
                    aria-label={`Remove ${entry.id}`}
                    onclick={() => void removeExtraModel(entry.id)}
                  >
                    <Trash2 class="size-3.5" />
                  </button>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <!-- Advanced -->
      <details class="rounded-xl border border-border bg-muted/30 px-4 py-3">
        <summary class="cursor-pointer list-none text-sm font-semibold text-foreground [&::marker]:hidden">
          Advanced sampling &amp; prompt
        </summary>
        <div class="mt-4 space-y-4 text-sm">
          <label class="block space-y-1.5">
            <span class="font-medium text-[var(--text-secondary)]">System prompt</span>
            <textarea
              class="aui-input h-20 w-full resize-none"
              bind:value={draft.systemPrompt}
              onchange={() => void saveSampling()}
              placeholder="You are a helpful assistant…"
            ></textarea>
          </label>
          <div class="space-y-1.5">
            <div class="flex items-center justify-between">
              <span class="font-medium text-[var(--text-secondary)]">Temperature</span>
              <span class="w-8 text-right text-xs font-semibold tabular-nums text-[var(--text-muted)]">{draft.temperature.toFixed(2)}</span>
            </div>
            <input type="range" min="0" max="2" step="0.05" bind:value={draft.temperature} onchange={() => void saveSampling()} class="h-1.5 w-full cursor-pointer rounded-full accent-[var(--primary)]" />
          </div>
          <div class="space-y-1.5">
            <div class="flex items-center justify-between">
              <span class="font-medium text-[var(--text-secondary)]">Top-P</span>
              <span class="w-8 text-right text-xs font-semibold tabular-nums text-[var(--text-muted)]">{draft.topP.toFixed(2)}</span>
            </div>
            <input type="range" min="0" max="1" step="0.05" bind:value={draft.topP} onchange={() => void saveSampling()} class="h-1.5 w-full cursor-pointer rounded-full accent-[var(--primary)]" />
          </div>
          <label class="block space-y-1.5">
            <span class="font-medium text-[var(--text-secondary)]">Max tokens</span>
            <input
              class="aui-input w-full"
              bind:value={draft.maxTokens}
              inputmode="numeric"
              placeholder="Leave blank for provider default"
              onchange={() => void saveSampling()}
            />
          </label>
        </div>
      </details>

      <!-- Danger zone (custom endpoints only) -->
      {#if isRemovable}
        <section class="flex items-center justify-between gap-3 rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-3">
          <div class="min-w-0">
            <h4 class="text-sm font-semibold text-foreground">Remove endpoint</h4>
            <p class="text-xs text-muted-foreground">Deletes its saved key and model list.</p>
          </div>
          <button
            type="button"
            class="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-destructive/40 px-3 py-1.5 text-xs font-semibold text-[var(--error)] transition hover:bg-destructive/10"
            onclick={() => void removeEndpoint()}
          >
            <Trash2 class="size-3" />
            {copy.actions.remove}
          </button>
        </section>
      {/if}
    </div>
  </div>
</div>

<svelte:options runes={true} />

<!--
  One provider's page: connect it (key, address, test), pick its default
  model, and make it the route chats use. "Use for chats" is the only thing
  that switches routes; editing a key or URL never does.

  Outside Electron the model list falls back to a direct GET {base}/models,
  which keeps dev-in-browser and local-server setups working.
-->

<script lang="ts">
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import { get } from 'svelte/store';
  import { Check, CircleCheck, Eye, EyeOff, LoaderCircle, Plus, RefreshCw, Search, Trash2, TriangleAlert, X } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { invoke, isElectron } from '$lib/services/bridge';
  import { CLOUD_PROVIDERS, PROVIDER_DOCS, defaultBaseUrl, isProviderConfigured } from '$lib/utils/providers';
  import { Badge, Button, Disclosure, Input } from '$lib/components/ui';
  import ProviderIcon from '$lib/components/ui/ProviderIcon.svelte';
  import SettingsPage from '../SettingsPage.svelte';
  import SettingsSection from '../SettingsSection.svelte';

  let { providerId }: { providerId: string } = $props();

  type ConnectionResult =
    | { ok: true; models: string[] }
    | { ok: false; reason: 'no_key' | 'auth' | 'not_found' | 'rate_limited' | 'server' | 'unreachable' | 'bad_response'; status?: number; detail?: string };

  // ── Directory ────────────────────────────────────────────────────────
  const builtIn = $derived(CLOUD_PROVIDERS.find((p) => p.id === providerId));
  const customEntry = $derived(appStore.config.llm?.custom_providers?.find((p) => p.id === providerId));
  const label = $derived(builtIn?.label ?? customEntry?.label ?? providerId);
  const isCustom = $derived(!!(customEntry ?? providerId.startsWith('custom')));
  /** Local servers (LM Studio, Ollama) and custom endpoints may run keyless. */
  const keyOptional = $derived(builtIn?.group === 'local' || isCustom);

  const saved = $derived(appStore.config.llm?.providers?.[providerId]);
  const hasKey = $derived(!!saved?.has_api_key);
  const inUse = $derived(appStore.backendMode === 'api' && appStore.activeProviderName === providerId);

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
  let showKey = $state(false);

  function savedBaseUrl(id: string): string {
    return appStore.config.llm?.providers?.[id]?.base_url
      || appStore.config.llm?.custom_providers?.find((p) => p.id === id)?.base_url
      || CLOUD_PROVIDERS.find((p) => p.id === id)?.defaultBaseUrl
      || defaultBaseUrl(id);
  }

  function buildDraft(id: string): DetailDraft {
    const savedProvider = appStore.config.llm?.providers?.[id];
    return {
      baseUrl: savedBaseUrl(id),
      apiKey: '',
      temperature: Number(savedProvider?.temperature ?? 0.7),
      topP: Number(savedProvider?.top_p ?? 0.95),
      maxTokens: String(savedProvider?.max_tokens ?? ''),
      systemPrompt: savedProvider?.system_prompt ?? ''
    };
  }

  $effect(() => {
    // Switching providers rebuilds the draft; the password field never
    // round-trips a stored key. Config commits must NOT reset the form,
    // so only the provider id is tracked here.
    const id = providerId;
    untrack(() => {
      draft = buildDraft(id);
      showKey = false;
      connection = null;
      modelFetch.fetched = [];
      modelFetch.error = '';
      modelFetch.loaded = false;
      modelQuery = '';
      void loadModels();
    });
  });

  const keyDirty = $derived(draft.apiKey.trim().length > 0);
  const baseDirty = $derived(draft.baseUrl.trim() !== savedBaseUrl(providerId));

  type ProviderFields = Omit<Parameters<typeof appStore.updateProvider>[0], 'provider'>;

  async function persistFields(fields: ProviderFields) {
    await appStore.updateProvider({ provider: providerId, ...fields }, { activate: false });
  }

  async function saveConnection() {
    const fields: ProviderFields = {};
    if (keyDirty) fields.api_key = draft.apiKey.trim();
    if (baseDirty && draft.baseUrl.trim()) fields.base_url = draft.baseUrl.trim();
    if (!Object.keys(fields).length) return;
    await persistFields(fields);
    draft.apiKey = '';
    toastStore.success($t('providers.saved'));
    // A new key or address deserves a fresh check and a fresh model list.
    void testConnection();
  }

  // ── Connection test ──────────────────────────────────────────────────
  let testing = $state(false);
  let connection = $state<ConnectionResult | null>(null);

  function connectionMessage(result: ConnectionResult): string {
    const tr = get(t);
    if (result.ok) return tr('providers.testOk', { values: { n: result.models.length } });
    let host = draft.baseUrl;
    try { host = new URL(draft.baseUrl).host; } catch { /* keep as typed */ }
    return tr(`providers.fail.${result.reason}`, { values: { host, status: result.status ?? '' } });
  }

  async function testConnection() {
    if (testing) return;
    testing = true;
    try {
      connection = await invoke<ConnectionResult>('test_provider_connection', {
        baseUrl: draft.baseUrl.trim(),
        apiKey: draft.apiKey.trim() || undefined,
        providerName: providerId
      });
      if (connection.ok) {
        modelFetch.fetched = connection.models;
        modelFetch.loaded = true;
        modelFetch.error = '';
      }
    } catch (err) {
      connection = { ok: false, reason: 'unreachable', detail: (err as Error)?.message };
    } finally {
      testing = false;
    }
  }

  // ── Use for chats ────────────────────────────────────────────────────
  const canUse = $derived(keyOptional || hasKey || keyDirty);

  async function useForChats() {
    try {
      const fields: ProviderFields = { base_url: draft.baseUrl.trim(), model: saved?.model || '' };
      if (keyDirty) {
        fields.api_key = draft.apiKey.trim();
        draft.apiKey = '';
      }
      await appStore.setBackendMode('api');
      await appStore.updateProvider({ provider: providerId, ...fields });
      toastStore.success($t('providers.nowUsing', { values: { name: label } }));
    } catch (err) {
      toastStore.error((err as Error)?.message || String(err));
    }
  }

  // ── Models ───────────────────────────────────────────────────────────
  const modelFetch = $state({ fetched: [] as string[], loading: false, error: '', loaded: false });
  let modelQuery = $state('');

  const extraModels = $derived(saved?.extra_models ?? []);
  /** Default model first, then fetched ids, then hand-added ids. */
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
  const visibleRoster = $derived.by(() => {
    const query = modelQuery.trim().toLowerCase();
    const list = query ? roster.filter((entry) => entry.id.toLowerCase().includes(query)) : roster;
    return list.slice(0, 200);
  });

  async function loadModels(force = false) {
    if (modelFetch.loading) return;
    if (!force && modelFetch.loaded) return;
    if (!isProviderConfigured(appStore.config, providerId) && !keyOptional && !draft.apiKey.trim() && !isElectron()) {
      return; // nothing to authenticate with yet
    }
    modelFetch.loading = true;
    modelFetch.error = '';
    try {
      modelFetch.fetched = await invoke<string[]>('fetch_provider_models', {
        baseUrl: draft.baseUrl,
        apiKey: draft.apiKey.trim() || undefined,
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
      } else if (hasKey || keyOptional) {
        // Without a key the empty state already explains what to do.
        modelFetch.error = (err as Error)?.message || String(err);
      }
    } finally {
      modelFetch.loading = false;
    }
  }

  async function setDefaultModel(id: string) {
    await persistFields({ model: id });
    toastStore.success($t('providers.defaultModelSet', { values: { model: id } }));
  }

  let addingModel = $state(false);
  let newModelId = $state('');

  async function addExtraModel() {
    const id = newModelId.trim();
    if (!id) return;
    if (roster.some((entry) => entry.id === id)) {
      toastStore.info($t('providers.modelExists'));
      return;
    }
    await persistFields({ extra_models: [...extraModels, id] });
    newModelId = '';
    addingModel = false;
  }

  async function removeExtraModel(id: string) {
    await persistFields({ extra_models: extraModels.filter((m) => m !== id) });
  }

  async function saveSampling() {
    await persistFields({
      temperature: draft.temperature,
      top_p: draft.topP,
      max_tokens: draft.maxTokens ? parseInt(draft.maxTokens) : undefined,
      system_prompt: draft.systemPrompt || undefined
    });
  }

  // ── Custom-endpoint removal ──────────────────────────────────────────
  async function removeEndpoint() {
    const accepted = await confirmStore.ask({
      title: $t('providers.removeTitle', { values: { name: label } }),
      message: $t('providers.removeMessage'),
      confirmLabel: $t('providers.remove'),
      danger: true
    });
    if (!accepted) return;
    try {
      await appStore.removeCustomProvider(providerId);
      toastStore.success($t('providers.removed'));
    } catch (err) {
      toastStore.error((err as Error)?.message || String(err));
    }
  }
</script>

<SettingsPage
  title={label}
  description={isCustom ? $t('providers.customDescription') : builtIn?.group === 'local' ? $t('providers.localDescription') : $t('providers.cloudDescription')}
>
  {#snippet icon()}<ProviderIcon provider={providerId} size={22} />{/snippet}
  {#snippet actions()}
    {#if inUse}
      <Badge tone="success" class="gap-1 px-2.5 py-1 text-[11px]"><CircleCheck class="size-3" /> {$t('providers.inUse')}</Badge>
    {:else}
      <Button size="sm" onclick={() => void useForChats()} disabled={!canUse} title={canUse ? '' : $t('providers.needsKey')}>
        {$t('providers.useForChats')}
      </Button>
    {/if}
  {/snippet}

  <!-- Connection -->
  <SettingsSection title={$t('providers.connection')} description={keyOptional ? $t('providers.connectionLocalHint') : $t('providers.connectionHint', { values: { name: label } })}>
    <div class="space-y-1.5 py-3">
      <div class="flex items-center justify-between gap-2">
        <label for="provider-key" class="text-sm font-medium text-foreground">
          {$t('providers.apiKey')}{#if keyOptional}<span class="font-normal text-muted-foreground"> · {$t('providers.optional')}</span>{/if}
        </label>
        {#if builtIn?.keyUrl}
          <a href={builtIn.keyUrl} target="_blank" rel="noreferrer" class="text-xs text-muted-foreground hover:text-foreground hover:underline">{$t('providers.getKey')} ↗</a>
        {/if}
      </div>
      <div class="flex gap-2">
        <div class="relative min-w-0 flex-1">
          <Input
            id="provider-key"
            type={showKey ? 'text' : 'password'}
            bind:value={draft.apiKey}
            autocomplete="off"
            spellcheck="false"
            class="pr-9"
            placeholder={hasKey ? $t('providers.keySavedPlaceholder') : $t('providers.keyPlaceholder')}
            onkeydown={(e) => { if (e.key === 'Enter') void saveConnection(); }}
          />
          <button
            type="button"
            class="absolute right-1.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
            aria-label={showKey ? $t('providers.hideKey') : $t('providers.showKey')}
            onclick={() => (showKey = !showKey)}
          >
            {#if showKey}<EyeOff class="size-3.5" />{:else}<Eye class="size-3.5" />{/if}
          </button>
        </div>
      </div>
      {#if hasKey && !keyDirty}
        <p class="flex items-center gap-1.5 text-xs text-muted-foreground"><Check class="size-3 text-success" /> {$t('providers.keySaved')}</p>
      {/if}
    </div>

    <div class="space-y-1.5 py-3">
      <label for="provider-url" class="text-sm font-medium text-foreground">{$t('providers.baseUrl')}</label>
      <Input
        id="provider-url"
        bind:value={draft.baseUrl}
        spellcheck="false"
        placeholder={builtIn?.defaultBaseUrl || 'https://api.example.com/v1'}
        onkeydown={(e) => { if (e.key === 'Enter') void saveConnection(); }}
      />
    </div>

    <div class="flex flex-wrap items-center justify-between gap-2 py-3">
      <div class="min-w-0 text-xs" role="status">
        {#if testing}
          <span class="inline-flex items-center gap-1.5 text-muted-foreground"><LoaderCircle class="size-3.5 animate-spin" /> {$t('providers.testing')}</span>
        {:else if connection}
          <span class="inline-flex items-start gap-1.5 {connection.ok ? 'text-success' : 'text-error'}">
            {#if connection.ok}<CircleCheck class="mt-px size-3.5 shrink-0" />{:else}<TriangleAlert class="mt-px size-3.5 shrink-0" />{/if}
            <span>{connectionMessage(connection)}</span>
          </span>
        {/if}
      </div>
      <div class="flex items-center gap-1.5">
        <Button variant="ghost" size="sm" onclick={() => void testConnection()} disabled={testing}>{$t('providers.test')}</Button>
        <Button variant="outline" size="sm" onclick={() => void saveConnection()} disabled={!keyDirty && !baseDirty}>{$t('providers.save')}</Button>
      </div>
    </div>
  </SettingsSection>

  <!-- Models -->
  <SettingsSection title={$t('providers.models')} description={$t('providers.modelsHint')} flush>
    {#snippet actions()}
      <Button variant="ghost" size="icon-sm" onclick={() => void loadModels(true)} disabled={modelFetch.loading} aria-label={$t('providers.refreshModels')} title={$t('providers.refreshModels')}>
        {#if modelFetch.loading}<LoaderCircle class="animate-spin" />{:else}<RefreshCw />{/if}
      </Button>
      <Button variant="ghost" size="icon-sm" onclick={() => (addingModel = !addingModel)} aria-label={$t('providers.addModel')} title={$t('providers.addModel')}>
        {#if addingModel}<X />{:else}<Plus />{/if}
      </Button>
    {/snippet}

    <div class="space-y-2 px-4 pb-2 pt-1">
      {#if addingModel}
        <div class="flex gap-2">
          <Input
            bind:value={newModelId}
            placeholder={$t('providers.modelIdPlaceholder')}
            onkeydown={(e) => { if (e.key === 'Enter') void addExtraModel(); }}
          />
          <Button size="sm" class="h-9" onclick={() => void addExtraModel()} disabled={!newModelId.trim()}>{$t('providers.add')}</Button>
        </div>
      {/if}
      {#if roster.length > 8}
        <div class="relative">
          <Search class="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input bind:value={modelQuery} class="pl-8" placeholder={$t('providers.searchModels', { values: { n: roster.length } })} />
        </div>
      {/if}
      {#if modelFetch.error}
        <p class="rounded-lg bg-error-bg px-3 py-2 text-xs text-error">{modelFetch.error}</p>
      {/if}
    </div>

    {#if roster.length === 0 && !modelFetch.loading}
      <p class="px-4 pb-3 text-xs text-muted-foreground">
        {keyOptional || hasKey ? $t('providers.noModelsYet') : $t('providers.noModelsNeedKey')}
      </p>
    {:else}
      <ul class="max-h-80 overflow-y-auto px-2 pb-1" role="radiogroup" aria-label={$t('providers.models')}>
        {#each visibleRoster as entry (entry.id)}
          {@const isDefault = saved?.model === entry.id}
          <li class="group flex items-center gap-1 rounded-lg pr-1 hover:bg-[var(--surface-hover)]">
            <button
              type="button"
              role="radio"
              aria-checked={isDefault}
              class="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-left"
              onclick={() => void setDefaultModel(entry.id)}
            >
              <span class="flex size-4 shrink-0 items-center justify-center rounded-full border {isDefault ? 'border-primary bg-primary text-primary-fg' : 'border-border'}">
                {#if isDefault}<Check class="size-2.5" />{/if}
              </span>
              <span class="min-w-0 flex-1 truncate text-[12px] {isDefault ? 'font-semibold text-foreground' : 'text-[var(--text-secondary)]'}" title={entry.id}>{entry.id}</span>
              {#if isDefault}<span class="shrink-0 text-[11px] text-muted-foreground">{$t('providers.default')}</span>{/if}
              {#if entry.added}<Badge class="shrink-0">{$t('providers.added')}</Badge>{/if}
            </button>
            {#if entry.added}
              <button
                type="button"
                class="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-0 transition hover:text-error focus-visible:opacity-100 group-hover:opacity-100"
                aria-label={$t('providers.removeModel', { values: { model: entry.id } })}
                onclick={() => void removeExtraModel(entry.id)}
              >
                <Trash2 class="size-3.5" />
              </button>
            {/if}
          </li>
        {:else}
          <li class="px-2 py-2 text-xs text-muted-foreground">{$t('providers.noMatches')}</li>
        {/each}
      </ul>
    {/if}
  </SettingsSection>

  <!-- Generation defaults for this provider -->
  <Disclosure title={$t('providers.generation')} description={$t('providers.generationHint')} class="rounded-[0.875rem] border border-[var(--border)] bg-[var(--card)]">
    <div class="space-y-4 text-sm">
      <label class="block space-y-1.5">
        <span class="text-xs font-medium text-muted-foreground">{$t('providers.systemPrompt')}</span>
        <textarea
          class="aui-input h-20 w-full resize-none"
          bind:value={draft.systemPrompt}
          onchange={() => void saveSampling()}
          placeholder={$t('providers.systemPromptPlaceholder')}
        ></textarea>
      </label>
      <div class="grid gap-4 sm:grid-cols-2">
        <label class="block space-y-1.5">
          <span class="flex justify-between text-xs font-medium text-muted-foreground">{$t('providers.temperature')} <span class="tabular-nums">{draft.temperature.toFixed(2)}</span></span>
          <input type="range" min="0" max="2" step="0.05" bind:value={draft.temperature} onchange={() => void saveSampling()} class="w-full accent-[var(--primary)]" />
        </label>
        <label class="block space-y-1.5">
          <span class="flex justify-between text-xs font-medium text-muted-foreground">{$t('providers.topP')} <span class="tabular-nums">{draft.topP.toFixed(2)}</span></span>
          <input type="range" min="0" max="1" step="0.05" bind:value={draft.topP} onchange={() => void saveSampling()} class="w-full accent-[var(--primary)]" />
        </label>
      </div>
      <label class="block space-y-1.5">
        <span class="text-xs font-medium text-muted-foreground">{$t('providers.maxTokens')}</span>
        <Input bind:value={draft.maxTokens} inputmode="numeric" placeholder={$t('providers.maxTokensPlaceholder')} onchange={() => void saveSampling()} />
      </label>
    </div>
  </Disclosure>

  {#if PROVIDER_DOCS[providerId]}
    <p class="px-1 text-xs text-muted-foreground">
      <a href={PROVIDER_DOCS[providerId]} target="_blank" rel="noreferrer" class="hover:text-foreground hover:underline">{$t('providers.docs', { values: { name: label } })} ↗</a>
    </p>
  {/if}

  {#if isCustom}
    <SettingsSection tone="danger">
      <div class="flex items-center justify-between gap-3 py-3">
        <div class="min-w-0">
          <p class="text-sm font-medium text-foreground">{$t('providers.removeEndpoint')}</p>
          <p class="text-xs text-muted-foreground">{$t('providers.removeMessage')}</p>
        </div>
        <Button variant="outline" size="sm" class="text-error" onclick={() => void removeEndpoint()}>
          <Trash2 /> {$t('providers.remove')}
        </Button>
      </div>
    </SettingsSection>
  {/if}
</SettingsPage>

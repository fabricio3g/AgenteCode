<svelte:options runes={true} />

<!--
  One provider's page: connect it (key, address, test), pick its default
  model, and make it the route chats use. "Use for chats" is the only thing
  that switches routes; editing a key or URL never does.

  Outside Electron the model list falls back to a direct GET {base}/models,
  which keeps dev-in-browser and local-server setups working.
-->

<script lang="ts">
  import UiListRow from '$lib/components/ui/ListRow.svelte';

  import UiTextarea from '$lib/components/ui/Textarea.svelte';
  import UiRange from '$lib/components/ui/Range.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { listedModels } from '$lib/services/listed-models';
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import { get } from 'svelte/store';
  import { Check, CircleCheck, Eye, EyeOff, LoaderCircle, Plus, RefreshCw, Search, Trash2, TriangleAlert, X } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { invoke, isElectron } from '$lib/services/bridge';
  import { defaultBaseUrl, isProviderConfigured, providerMeta } from '$lib/utils/providers';
  import { humanizeProviderError } from '$lib/utils/errors';
  import { Badge, Button, Disclosure, IconButton, Input, Tooltip } from '$lib/components/ui';
  import ProviderIcon from '$lib/components/ui/ProviderIcon.svelte';
  import SettingsPage from '../SettingsPage.svelte';
  import SettingsRow from '../SettingsRow.svelte';
  import SettingsSection from '../SettingsSection.svelte';
  import ModelSearchField from '../ModelSearchField.svelte';

  let { providerId }: { providerId: string } = $props();

  type ConnectionResult =
    | { ok: true; models: string[] }
    | { ok: false; reason: 'no_key' | 'auth' | 'not_found' | 'rate_limited' | 'server' | 'unreachable' | 'bad_response'; status?: number; detail?: string };

  // ── Directory ────────────────────────────────────────────────────────
  const builtIn = $derived(providerMeta(providerId));
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
      || providerMeta(id)?.defaultBaseUrl
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
      modelFetch.availability = {};
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
  const modelFetch = $state({ fetched: [] as string[], availability: {} as Record<string, 'catalog' | 'retired' | undefined>, loading: false, error: '', loaded: false });
  let modelQuery = $state('');

  const extraModels = $derived(saved?.extra_models ?? []);
  /** Default model first, then fetched ids, then hand-added ids. */
  const roster = $derived.by(() => {
    const seen = new Set<string>();
    const list: Array<{ id: string; added: boolean; availability?: 'catalog' | 'retired' }> = [];
    for (const id of [saved?.model, ...modelFetch.fetched, ...extraModels]) {
      const value = String(id || '').trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      list.push({ id: value, added: extraModels.includes(value), availability: modelFetch.availability[value] });
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
      const listed = listedModels(await invoke<unknown>('fetch_provider_models', {
        baseUrl: draft.baseUrl,
        apiKey: draft.apiKey.trim() || undefined,
        providerName: providerId
      }));
      modelFetch.fetched = listed.map((model) => model.id);
      modelFetch.availability = Object.fromEntries(listed.map((model) => [model.id, model.availability]));
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
          modelFetch.error = humanizeProviderError(directErr);
        }
      } else if (hasKey || keyOptional) {
        // Without a key the empty state already explains what to do.
        modelFetch.error = humanizeProviderError(err);
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
  {#snippet icon()}<ProviderIcon provider={providerId} size={26} />{/snippet}
  {#snippet actions()}
    {#if inUse}
      <Badge tone="neutral" class="gap-1.5"><CircleCheck class="size-3.5" /> {$t('providers.inUse')}</Badge>
    {:else}
      <Button onclick={() => void useForChats()} disabled={!canUse} title={canUse ? '' : $t('providers.needsKey')}>
        {$t('providers.useForChats')}
      </Button>
    {/if}
  {/snippet}

  <!-- Connection -->
  <SettingsSection title={$t('providers.connection')} description={keyOptional ? $t('providers.connectionLocalHint') : $t('providers.connectionHint', { values: { name: label } })}>
    <SettingsRow
      label={keyOptional ? `${$t('providers.apiKey')} · ${$t('providers.optional')}` : $t('providers.apiKey')}
      description={hasKey && !keyDirty ? $t('providers.keySaved') : undefined}
      htmlFor="provider-key"
      control="lg"
    >
      <div class="relative">
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
        <IconButton
          label={showKey ? $t('providers.hideKey') : $t('providers.showKey')}
          class="absolute right-0.5 top-1/2 -translate-y-1/2"
          onclick={() => (showKey = !showKey)}
        >
          {#if showKey}<EyeOff />{:else}<Eye />{/if}
        </IconButton>
      </div>
      {#if builtIn?.keyUrl}
        <a href={builtIn.keyUrl} target="_blank" rel="noreferrer" class="mt-1.5 block text-[length:var(--text-xs)] text-muted-foreground hover:text-foreground hover:underline">{$t('providers.getKey')} ↗</a>
      {/if}
    </SettingsRow>

    <SettingsRow label={$t('providers.baseUrl')} htmlFor="provider-url" control="lg">
      <Input
        id="provider-url"
        bind:value={draft.baseUrl}
        spellcheck="false"
        placeholder={builtIn?.defaultBaseUrl || 'https://api.example.com/v1'}
        onkeydown={(e) => { if (e.key === 'Enter') void saveConnection(); }}
      />
    </SettingsRow>

    <div class="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
      <div class="min-w-0 text-[length:var(--text-xs)]" role="status">
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
        <Button variant="outline" size="sm" onclick={() => void testConnection()} disabled={testing}>{$t('providers.test')}</Button>
        <Button variant="outline" size="sm" onclick={() => void saveConnection()} disabled={!keyDirty && !baseDirty}>{$t('providers.save')}</Button>
      </div>
    </div>
  </SettingsSection>

  <!-- Models -->
  <SettingsSection title={$t('providers.models')} description={$t('providers.modelsHint')} flush>
    {#snippet actions()}
      <Tooltip label={$t('providers.refreshModels')} position="bottom"><Button variant="ghost" size="icon-sm" onclick={() => void loadModels(true)} disabled={modelFetch.loading} aria-label={$t('providers.refreshModels')}>
        {#if modelFetch.loading}<LoaderCircle class="animate-spin" />{:else}<RefreshCw />{/if}
      </Button></Tooltip>
      <Tooltip label={$t('providers.addModel')} position="bottom"><Button variant="ghost" size="icon-sm" onclick={() => (addingModel = !addingModel)} aria-label={$t('providers.addModel')}>
        {#if addingModel}<X />{:else}<Plus />{/if}
      </Button></Tooltip>
    {/snippet}

    {#if addingModel || roster.length > 12 || modelFetch.error}
      <div class="space-y-2 border-b border-[var(--border-subtle)] px-3 py-2.5">
        {#if addingModel}
          <div class="flex gap-2">
            <Input
              bind:value={newModelId}
              placeholder={$t('providers.modelIdPlaceholder')}
              onkeydown={(e) => { if (e.key === 'Enter') void addExtraModel(); }}
            />
            <Button onclick={() => void addExtraModel()} disabled={!newModelId.trim()}>{$t('providers.add')}</Button>
          </div>
        {/if}
        {#if roster.length > 12}
          <ModelSearchField bind:value={modelQuery} placeholder={$t('providers.searchModels', { values: { n: roster.length } })} label={$t('providers.searchModels', { values: { n: roster.length } })} />
        {/if}
        {#if modelFetch.error}
          <p class="rounded-[var(--float-row-radius)] bg-error-bg px-3 py-2 text-[length:var(--text-xs)] text-error">{modelFetch.error}</p>
        {/if}
      </div>
    {/if}

    {#if roster.length === 0 && !modelFetch.loading}
      <p class="px-4 py-4 text-[length:var(--text-sm)] text-muted-foreground">
        {keyOptional || hasKey ? $t('providers.noModelsYet') : $t('providers.noModelsNeedKey')}
      </p>
    {:else}
      <ul class="max-h-[28rem] overflow-y-auto p-1" role="radiogroup" aria-label={$t('providers.models')}>
        {#each visibleRoster as entry (entry.id)}
          {@const isDefault = saved?.model === entry.id}
          <li class="group flex items-center gap-1 rounded-[var(--float-row-radius)] pr-1 hover:bg-[var(--float-row-hover)]">
            <UiListRow
              type="button"
              role="radio"
              aria-checked={isDefault}
              class={uiClass("ui-row min-w-0 flex-1 text-left hover:!bg-transparent")}
              onclick={() => void setDefaultModel(entry.id)}
            >
              <span class="min-w-0 flex-1 truncate {isDefault ? 'font-medium' : 'text-[var(--text-secondary)]'}" title={entry.id}>{entry.id}</span>
              {#if entry.availability === 'retired'}<span class="shrink-0 text-[length:var(--text-xs)] text-warning" title={$t('modelPicker.retiredHint')}>{$t('modelPicker.retired')}</span>
              {:else if entry.availability === 'catalog'}
                <span class="shrink-0 text-[length:var(--text-xs)] text-muted-foreground" title={$t('modelPicker.notListedHint')}>{$t('modelPicker.notListed')}</span>
              {/if}
              {#if entry.added}<Badge class="shrink-0">{$t('providers.added')}</Badge>{/if}
              {#if isDefault}<span class="shrink-0 text-[length:var(--text-xs)] text-muted-foreground">{$t('providers.default')}</span><Check class="size-4 shrink-0" />{/if}
            </UiListRow>
            {#if entry.added}
              <IconButton
                label={$t('providers.removeModel', { values: { model: entry.id } })}
                class="text-muted-foreground opacity-0 hover:text-error focus-visible:opacity-100 group-hover:opacity-100"
                onclick={() => void removeExtraModel(entry.id)}
              >
                <Trash2 />
              </IconButton>
            {/if}
          </li>
        {:else}
          <li class="px-2.5 py-2.5 text-[length:var(--text-sm)] text-muted-foreground">{$t('providers.noMatches')}</li>
        {/each}
      </ul>
    {/if}
  </SettingsSection>

  <!-- Generation defaults for this provider -->
  <Disclosure title={$t('providers.generation')} description={$t('providers.generationHint')}>
    <div class="space-y-4 text-sm">
      <label class="block space-y-1.5">
        <span class="text-xs font-medium text-muted-foreground">{$t('providers.systemPrompt')}</span>
        <UiTextarea
          class={uiClass(" h-20 w-full resize-none")}
          bind:value={draft.systemPrompt}
          onchange={() => void saveSampling()}
          placeholder={$t('providers.systemPromptPlaceholder')}
        ></UiTextarea>
      </label>
      <div class="grid gap-4 sm:grid-cols-2">
        <label class="block space-y-1.5">
          <span class="flex justify-between text-xs font-medium text-muted-foreground">{$t('providers.temperature')} <span class="tabular-nums">{draft.temperature.toFixed(2)}</span></span>
          <UiRange  min="0" max="2" step="0.05" bind:value={draft.temperature} onchange={() => void saveSampling()} class={uiClass("w-full accent-[var(--primary)]")} />
        </label>
        <label class="block space-y-1.5">
          <span class="flex justify-between text-xs font-medium text-muted-foreground">{$t('providers.topP')} <span class="tabular-nums">{draft.topP.toFixed(2)}</span></span>
          <UiRange  min="0" max="1" step="0.05" bind:value={draft.topP} onchange={() => void saveSampling()} class={uiClass("w-full accent-[var(--primary)]")} />
        </label>
      </div>
      <label class="block space-y-1.5">
        <span class="text-xs font-medium text-muted-foreground">{$t('providers.maxTokens')}</span>
        <Input bind:value={draft.maxTokens} inputmode="numeric" placeholder={$t('providers.maxTokensPlaceholder')} onchange={() => void saveSampling()} />
      </label>
    </div>
  </Disclosure>

  {#if builtIn?.docsUrl}
    <p class="px-1 text-[length:var(--text-xs)] text-muted-foreground">
      <a href={builtIn.docsUrl} target="_blank" rel="noreferrer" class="hover:text-foreground hover:underline">{$t('providers.docs', { values: { name: label } })} ↗</a>
    </p>
  {/if}

  {#if isCustom}
    <SettingsSection tone="danger">
      <div class="flex items-center justify-between gap-3 px-4 py-4 sm:px-5">
        <div class="min-w-0">
          <p class="text-sm font-medium text-foreground">{$t('providers.removeEndpoint')}</p>
          <p class="text-xs text-muted-foreground">{$t('providers.removeMessage')}</p>
        </div>
        <Button variant="outline" size="sm" class="hover:text-error" onclick={() => void removeEndpoint()}>
          <Trash2 /> {$t('providers.remove')}
        </Button>
      </div>
    </SettingsSection>
  {/if}
</SettingsPage>

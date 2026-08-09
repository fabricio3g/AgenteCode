<svelte:options runes={true} />

<script lang="ts">
  import { Check, ChevronDown, LoaderCircle, RefreshCw } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { invoke } from '$lib/services/tauri';
  import { motionSlide } from '$lib/utils/transitions';
  import {
    CLOUD_PROVIDERS,
    defaultBaseUrl,
    isProviderConfigured,
    providerLabel
  } from '$lib/utils/providers';

  let expandedId = $state(appStore.activeProviderName || 'openai');
  let providerBaseUrl = $state('');
  let providerApiKey = $state('');
  let providerModel = $state('');
  let providerTemperature = $state(0.7);
  let providerTopP = $state(0.95);
  let providerMaxTokens = $state('');
  let providerSystemPrompt = $state('');
  let providerApiModels = $state<string[]>([]);
  let modelSearchQuery = $state('');
  let modelDropdownOpen = $state(false);
  let fetchingProviderModels = $state(false);
  let savingProvider = $state(false);
  let testingProviderConnection = $state(false);
  let providerConnectionStatus = $state<'idle' | 'ok' | 'fail'>('idle');

  const filteredProviderModels = $derived(
    modelSearchQuery
      ? providerApiModels.filter((m) => m.toLowerCase().includes(modelSearchQuery.toLowerCase()))
      : providerApiModels
  );

  const cloudList = $derived(CLOUD_PROVIDERS.filter((p) => p.group === 'cloud'));
  const localList = $derived(CLOUD_PROVIDERS.filter((p) => p.group === 'local'));

  function loadProviderForm(id: string) {
    const saved = appStore.config.llm?.providers?.[id];
    providerBaseUrl = saved?.base_url || defaultBaseUrl(id);
    if (saved?.api_key) {
      providerApiKey = saved.api_key;
    } else if (saved?.has_api_key) {
      providerApiKey = '••••••••';
    } else {
      providerApiKey = '';
    }
    providerModel = saved?.model || '';
    providerTemperature = Number(saved?.temperature ?? 0.7);
    providerTopP = Number(saved?.top_p ?? 0.95);
    providerMaxTokens = String(saved?.max_tokens || '');
    providerSystemPrompt = saved?.system_prompt || appStore.config.llm?.system_prompt || '';
    providerApiModels = [];
    modelSearchQuery = '';
    modelDropdownOpen = false;
    providerConnectionStatus = 'idle';
  }

  function selectProvider(id: string) {
    if (expandedId === id) {
      expandedId = '';
      return;
    }
    expandedId = id;
    loadProviderForm(id);
  }

  // Load form when expanding a provider (not on every config tick)
  let lastLoadedId = $state('');
  $effect(() => {
    if (expandedId && expandedId !== lastLoadedId) {
      lastLoadedId = expandedId;
      loadProviderForm(expandedId);
    }
  });

  async function fetchProviderModels() {
    if (!expandedId) return;
    fetchingProviderModels = true;
    providerApiModels = [];
    try {
      const keyToSend =
        providerApiKey && providerApiKey !== '••••••••' ? String(providerApiKey) : undefined;
      const models = await invoke<string[]>('fetch_provider_models', {
        baseUrl: providerBaseUrl,
        apiKey: keyToSend,
        providerName: expandedId
      });
      providerApiModels = models ?? [];
      if (!providerApiModels.length) toastStore.info('No models returned from provider.');
    } catch (err) {
      toastStore.error('Could not fetch models: ' + ((err as Error)?.message || String(err)));
    } finally {
      fetchingProviderModels = false;
    }
  }

  async function testProviderConnection() {
    if (!expandedId) return;
    testingProviderConnection = true;
    providerConnectionStatus = 'idle';
    try {
      const keyToSend =
        providerApiKey && providerApiKey !== '••••••••' ? String(providerApiKey) : undefined;
      await invoke('fetch_provider_models', {
        baseUrl: providerBaseUrl,
        apiKey: keyToSend,
        providerName: expandedId
      });
      providerConnectionStatus = 'ok';
      toastStore.success('Connected successfully');
    } catch (err) {
      providerConnectionStatus = 'fail';
      toastStore.error('Connection failed: ' + ((err as Error)?.message || String(err)));
    } finally {
      testingProviderConnection = false;
    }
  }

  async function saveProviderConfig() {
    if (!expandedId) return;
    const capturedKey = providerApiKey;
    const capturedProvider = expandedId;
    const capturedBaseUrl = providerBaseUrl;
    const capturedModel = providerModel;
    const capturedTemperature = providerTemperature;
    const capturedMaxTokens = providerMaxTokens;
    const capturedTopP = providerTopP;
    const capturedSystemPrompt = providerSystemPrompt;

    savingProvider = true;
    try {
      await appStore.setBackendMode('api');
      await appStore.updateProvider({
        provider: capturedProvider,
        base_url: capturedBaseUrl,
        api_key: capturedKey && capturedKey !== '••••••••' ? capturedKey : undefined,
        model: capturedModel,
        temperature: capturedTemperature,
        max_tokens: capturedMaxTokens ? parseInt(capturedMaxTokens) : undefined,
        top_p: capturedTopP,
        system_prompt: capturedSystemPrompt || undefined
      });
      toastStore.success(`${providerLabel(capturedProvider)} saved`);
    } catch (err) {
      toastStore.error('Failed to save: ' + ((err as Error)?.message || String(err)));
    } finally {
      savingProvider = false;
    }
  }

  function providerMeta(id: string) {
    const saved = appStore.config.llm?.providers?.[id];
    const configured = isProviderConfigured(appStore.config, id);
    const active = appStore.activeProviderName === id;
    return {
      configured,
      active,
      model: saved?.model || '',
      hasKey: !!(saved?.has_api_key || saved?.api_key)
    };
  }
</script>

<div>
  {#if appStore.backendMode !== 'api'}
    <div class="mb-4 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
      You are currently in <strong>Local</strong> mode. Saving a provider will switch to
      <strong>Cloud</strong> mode.
    </div>
  {/if}

  <div class="space-y-5">
    <section class="space-y-2">
      <h3 class="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">Cloud</h3>
      <div class="space-y-1.5">
        {#each cloudList as p (p.id)}
          {@const meta = providerMeta(p.id)}
          {@const open = expandedId === p.id}
          <div class="provider-row overflow-hidden rounded-xl border border-border bg-card">
            <button
              type="button"
              class="flex w-full items-center gap-3 px-3 py-2.5 text-left outline-none transition-colors duration-[var(--motion-fast)] hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/20"
              class:is-open={open}
              onclick={() => selectProvider(p.id)}
            >
              <span class="min-w-0 flex-1">
                <span class="flex items-center gap-2">
                  <span class="text-sm font-medium text-[var(--text)]">{p.label}</span>
                  {#if meta.active}
                    <span class="rounded-full bg-[var(--primary)]/15 px-1.5 py-0.5 text-[10px] font-semibold text-[var(--primary)]">Active</span>
                  {/if}
                  {#if meta.configured}
                    <span class="inline-flex items-center gap-1 text-[10px] font-medium text-[var(--text-secondary)]">
                      <span class="h-1.5 w-1.5 rounded-full bg-[var(--primary)]"></span>
                      Configured
                    </span>
                  {/if}
                </span>
                {#if meta.model}
                  <span class="mt-0.5 block truncate text-[11px] text-[var(--text-muted)]">{meta.model}</span>
                {/if}
              </span>
              <ChevronDown class="h-4 w-4 shrink-0 text-[var(--text-muted)] transition-transform {open ? 'rotate-180' : ''}" />
            </button>

            {#if open}
              <div class="space-y-4 border-t border-border px-3 py-3" transition:motionSlide={{ duration: 180 }}>
                <label class="block space-y-1.5 text-sm">
                  <span class="font-medium text-[var(--text-secondary)]">Base URL</span>
                  <input class="aui-input w-full" bind:value={providerBaseUrl} placeholder={p.defaultBaseUrl} />
                </label>

                <div class="space-y-1.5 text-sm">
                  <div class="flex items-center justify-between">
                    <span class="font-medium text-[var(--text-secondary)]">API Key</span>
                    {#if meta.hasKey}
                      <span class="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--text-secondary)]">
                        <span class="h-1.5 w-1.5 rounded-full bg-[var(--primary)]"></span> Saved
                      </span>
                    {/if}
                  </div>
                  <input
                    class="aui-input w-full"
                    bind:value={providerApiKey}
                    placeholder={meta.hasKey ? '••••••••• (leave blank to keep)' : 'Enter API key…'}
                    type="password"
                    onfocus={() => {
                      if (providerApiKey === '••••••••') providerApiKey = '';
                    }}
                  />
                </div>

                <div class="space-y-1.5 text-sm">
                  <span class="font-medium text-[var(--text-secondary)]">Model</span>
                  <div class="flex gap-2">
                    {#if providerApiModels.length}
                      <div class="relative flex-1">
                        <input
                          class="aui-input w-full"
                          value={modelDropdownOpen ? modelSearchQuery : providerModel || ''}
                          placeholder="Search models…"
                          onfocus={() => {
                            modelDropdownOpen = true;
                            modelSearchQuery = '';
                          }}
                          onblur={() => {
                            modelDropdownOpen = false;
                          }}
                          oninput={(e) => {
                            modelSearchQuery = e.currentTarget.value;
                            modelDropdownOpen = true;
                          }}
                        />
                        {#if modelDropdownOpen}
                          <!-- svelte-ignore a11y_no_static_element_interactions -->
                          <div
                            class="aui-menu absolute left-0 right-0 top-full z-50 mt-1 max-h-60 overflow-y-auto"
                            onmousedown={(e) => e.preventDefault()}
                          >
                            {#if filteredProviderModels.length === 0}
                              <div class="px-4 py-3 text-xs text-[var(--text-muted)]">No models match</div>
                            {:else}
                              {#each filteredProviderModels as m (m)}
                                <button
                                  type="button"
                                  class="flex w-full items-center px-4 py-2 text-left text-sm transition-colors hover:bg-[var(--surface-hover)] {m === providerModel
                                    ? 'font-medium text-[var(--primary)]'
                                    : 'text-[var(--text)]'}"
                                  onclick={() => {
                                    providerModel = m;
                                    modelDropdownOpen = false;
                                    modelSearchQuery = '';
                                  }}
                                >
                                  {#if m === providerModel}<Check class="mr-2 h-3.5 w-3.5" />{/if}
                                  {m}
                                </button>
                              {/each}
                            {/if}
                          </div>
                        {/if}
                      </div>
                    {:else}
                      <input class="aui-input flex-1" bind:value={providerModel} placeholder="Model id" />
                    {/if}
                    <button
                      type="button"
                      class="inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:opacity-50"
                      onclick={fetchProviderModels}
                      disabled={fetchingProviderModels}
                      title="Fetch available models"
                    >
                      {#if fetchingProviderModels}
                        <LoaderCircle class="h-4 w-4 animate-spin" />
                      {:else}
                        <RefreshCw class="h-3.5 w-3.5" />
                      {/if}
                      Fetch
                    </button>
                  </div>
                </div>

                <label class="block space-y-1.5 text-sm">
                  <span class="font-medium text-[var(--text-secondary)]">System prompt</span>
                  <textarea
                    class="aui-input h-20 w-full resize-none"
                    bind:value={providerSystemPrompt}
                    placeholder="You are a helpful assistant…"
                  ></textarea>
                </label>

                <div class="space-y-4 text-sm">
                  <div class="space-y-1.5">
                    <div class="flex items-center justify-between">
                      <span class="font-medium text-[var(--text-secondary)]">Temperature</span>
                      <span class="w-8 text-right text-xs font-semibold tabular-nums text-[var(--text-muted)]"
                        >{providerTemperature.toFixed(2)}</span
                      >
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="2"
                      step="0.05"
                      bind:value={providerTemperature}
                      class="h-1.5 w-full cursor-pointer rounded-full accent-[var(--primary)]"
                    />
                  </div>
                  <div class="space-y-1.5">
                    <div class="flex items-center justify-between">
                      <span class="font-medium text-[var(--text-secondary)]">Top-P</span>
                      <span class="w-8 text-right text-xs font-semibold tabular-nums text-[var(--text-muted)]"
                        >{providerTopP.toFixed(2)}</span
                      >
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      bind:value={providerTopP}
                      class="h-1.5 w-full cursor-pointer rounded-full accent-[var(--primary)]"
                    />
                  </div>
                  <label class="block space-y-1.5">
                    <span class="font-medium text-[var(--text-secondary)]">Max tokens</span>
                    <input
                      class="aui-input w-full"
                      bind:value={providerMaxTokens}
                      inputmode="numeric"
                      placeholder="Leave blank for provider default"
                    />
                  </label>
                </div>

                <div class="flex flex-wrap items-center gap-3 border-t border-[var(--border)] pt-3">
                  <button
                    type="button"
                    class="inline-flex items-center gap-1.5 rounded-md bg-[var(--primary)] px-4 py-2 text-xs font-semibold text-[var(--primary-fg)] transition hover:opacity-90 disabled:opacity-50"
                    onclick={saveProviderConfig}
                    disabled={savingProvider}
                  >
                    {savingProvider ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    type="button"
                    class="inline-flex items-center gap-2 rounded-md px-3 py-2 text-xs font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:opacity-50"
                    onclick={testProviderConnection}
                    disabled={testingProviderConnection}
                  >
                    {#if testingProviderConnection}
                      <LoaderCircle class="h-3.5 w-3.5 animate-spin" />
                      Testing…
                    {:else}
                      Test connection
                    {/if}
                  </button>
                  {#if providerConnectionStatus !== 'idle'}
                    <span class="text-xs font-medium text-[var(--text-secondary)]">
                      {providerConnectionStatus === 'ok' ? '● Connected' : '● Failed'}
                    </span>
                  {/if}
                </div>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </section>

    <section class="space-y-2">
      <h3 class="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
        Local / Self-hosted
      </h3>
      <div class="space-y-1.5">
        {#each localList as p (p.id)}
          {@const meta = providerMeta(p.id)}
          {@const open = expandedId === p.id}
          <div class="provider-row overflow-hidden rounded-xl border border-border bg-card">
            <button
              type="button"
              class="flex w-full items-center gap-3 px-3 py-2.5 text-left outline-none transition-colors duration-[var(--motion-fast)] hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/20"
              onclick={() => selectProvider(p.id)}
            >
              <span class="min-w-0 flex-1">
                <span class="flex items-center gap-2">
                  <span class="text-sm font-medium text-[var(--text)]">{p.label}</span>
                  {#if meta.active}
                    <span class="rounded-full bg-[var(--primary)]/15 px-1.5 py-0.5 text-[10px] font-semibold text-[var(--primary)]">Active</span>
                  {/if}
                  {#if meta.configured}
                    <span class="inline-flex items-center gap-1 text-[10px] font-medium text-[var(--text-secondary)]">
                      <span class="h-1.5 w-1.5 rounded-full bg-[var(--primary)]"></span>
                      Configured
                    </span>
                  {/if}
                </span>
                {#if meta.model}
                  <span class="mt-0.5 block truncate text-[11px] text-[var(--text-muted)]">{meta.model}</span>
                {/if}
              </span>
              <ChevronDown class="h-4 w-4 shrink-0 text-[var(--text-muted)] transition-transform {open ? 'rotate-180' : ''}" />
            </button>

            {#if open}
              <div class="space-y-4 border-t border-border px-3 py-3" transition:motionSlide={{ duration: 180 }}>
                <label class="block space-y-1.5 text-sm">
                  <span class="font-medium text-[var(--text-secondary)]">Base URL</span>
                  <input class="aui-input w-full" bind:value={providerBaseUrl} placeholder={p.defaultBaseUrl} />
                </label>
                <div class="space-y-1.5 text-sm">
                  <span class="font-medium text-[var(--text-secondary)]">API Key (optional)</span>
                  <input
                    class="aui-input w-full"
                    bind:value={providerApiKey}
                    type="password"
                    placeholder="Optional for local servers"
                  />
                </div>
                <div class="space-y-1.5 text-sm">
                  <span class="font-medium text-[var(--text-secondary)]">Model</span>
                  <div class="flex gap-2">
                    <input class="aui-input flex-1" bind:value={providerModel} placeholder="Model id" />
                    <button
                      type="button"
                      class="inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] disabled:opacity-50"
                      onclick={fetchProviderModels}
                      disabled={fetchingProviderModels}
                    >
                      {#if fetchingProviderModels}
                        <LoaderCircle class="h-4 w-4 animate-spin" />
                      {:else}
                        <RefreshCw class="h-3.5 w-3.5" />
                      {/if}
                      Fetch
                    </button>
                  </div>
                  {#if providerApiModels.length}
                    <div class="max-h-40 space-y-0.5 overflow-y-auto rounded-md border border-[var(--border)] p-1">
                      {#each providerApiModels as m (m)}
                        <button
                          type="button"
                          class="block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--surface-hover)] {m === providerModel
                            ? 'font-medium text-[var(--primary)]'
                            : ''}"
                          onclick={() => (providerModel = m)}
                        >
                          {m}
                        </button>
                      {/each}
                    </div>
                  {/if}
                </div>
                <div class="flex flex-wrap items-center gap-3 border-t border-[var(--border)] pt-3">
                  <button
                    type="button"
                    class="inline-flex items-center gap-1.5 rounded-md bg-[var(--primary)] px-4 py-2 text-xs font-semibold text-[var(--primary-fg)] disabled:opacity-50"
                    onclick={saveProviderConfig}
                    disabled={savingProvider}
                  >
                    {savingProvider ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    type="button"
                    class="inline-flex items-center gap-2 rounded-md px-3 py-2 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
                    onclick={testProviderConnection}
                    disabled={testingProviderConnection}
                  >
                    {#if testingProviderConnection}
                      <LoaderCircle class="h-3.5 w-3.5 animate-spin" />
                      Testing…
                    {:else}
                      Test connection
                    {/if}
                  </button>
                  {#if providerConnectionStatus !== 'idle'}
                    <span class="text-xs font-medium text-[var(--text-secondary)]">
                      {providerConnectionStatus === 'ok' ? '● Connected' : '● Failed'}
                    </span>
                  {/if}
                </div>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </section>
  </div>
</div>

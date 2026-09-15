<svelte:options runes={true} />

<script lang="ts">
  import { untrack } from 'svelte';
  import { Check, ChevronDown, Cpu, LoaderCircle, Play, Power, RefreshCw, Search, Settings2, Sparkles, Square, X } from 'lucide-svelte';
  import { flyAndScale, motionFade } from '$lib/utils/transitions';
  import { appStore } from '$lib/stores/app.svelte';
  import { modelsStore } from '$lib/stores/models.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { invoke, isElectron } from '$lib/services/bridge';
  import { Button } from '$lib/components/ui';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import ProviderIcon from '$lib/components/ui/ProviderIcon.svelte';
  import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
  import type { ModelOption } from '$lib/types/chat';
  import { buildLocalModelSecondaryText, formatContextLength, localModelMatchesSearch } from '$lib/utils/local-models';
  import { configuredProviders, defaultBaseUrl, providerLabel } from '$lib/utils/providers';

  const isAnyModelLoaded = $derived(!!appStore.localModelActive);
  const loadedModelName = $derived(appStore.localModelActive?.name || '');
  const loadedModelPath = $derived(appStore.localModelActive?.path?.toLowerCase() || '');
  const loadedModelFilename = $derived(
    loadedModelName
      ? loadedModelName.split('/').pop()?.split('\\').pop()?.replace(/\.gguf$/i, '') || loadedModelName
      : ''
  );

  let triggerEl: HTMLButtonElement | undefined = $state();
  let modelSearch = $state('');
  let searchInput = $state<HTMLInputElement | undefined>(undefined);
  let unloading = $state(false);
  let confirmSwitch = $state<ModelOption | null>(null);
  /** Cloud: models cached per provider id (`undefined` = not loaded yet) */
  let modelsByProvider = $state<Record<string, ModelOption[] | undefined>>({});
  let loadingProvider = $state<Record<string, boolean>>({});
  let expandedProviders = $state<Record<string, boolean>>({});
  let providerErrors = $state<Record<string, string>>({});
  let selectingModel = $state('');
  let changingMode = $state(false);
  let panelEl = $state<HTMLDivElement>();
  const dialogId = $props.id();

  const activeProvider = $derived(appStore.activeProvider);
  const displayLabel = $derived(appStore.activeModelLabel);
  const localLoading = $derived(appStore.localModelLoading);
  // Re-read nested provider flags reactively (has_api_key / model / active).
  const configured = $derived.by(() => {
    void appStore.config;
    void appStore.config?.llm?.provider;
    void appStore.config?.llm?.providers;
    void appStore.activeProviderName;
    void appStore.activeProvider?.model;
    void appStore.activeProvider?.has_api_key;
    return configuredProviders(appStore.config, { includeActiveAlways: true });
  });

  const filteredModels = $derived(
    modelSearch.trim()
      ? appStore.models.filter((m) =>
          appStore.backendMode === 'local'
            ? localModelMatchesSearch(m, modelSearch)
            : (m.name.toLowerCase().includes(modelSearch.toLowerCase()) ||
              m.id.toLowerCase().includes(modelSearch.toLowerCase()))
        )
      : appStore.models
  );

  function seedModels(id: string): ModelOption[] {
    const saved = appStore.config.llm?.providers?.[id];
    if (id === appStore.activeProviderName && appStore.models.length) {
      return appStore.models.slice();
    }
    if (saved?.model) {
      return [{ id: String(saved.model), name: String(saved.model), source: 'api' as const }];
    }
    return [];
  }

  function modelsForProvider(id: string): ModelOption[] {
    const cached = modelsByProvider[id];
    const list = cached !== undefined ? cached : seedModels(id);
    const q = modelSearch.trim().toLowerCase();
    const matchesProvider = providerLabel(id).toLowerCase().includes(q);
    const matches = !q || matchesProvider ? list : list.filter((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
    return matches.slice().sort((a, b) => {
      const selected = id === appStore.activeProviderName ? activeProvider?.model : '';
      return Number(b.id === selected) - Number(a.id === selected) || a.name.localeCompare(b.name);
    });
  }

  const visibleProviders = $derived(configured.filter((provider) => !modelSearch.trim() || modelsForProvider(provider.id).length || loadingProvider[provider.id] || providerErrors[provider.id]));
  const resultCount = $derived(appStore.backendMode === 'api' ? visibleProviders.reduce((sum, provider) => sum + modelsForProvider(provider.id).length, 0) : filteredModels.length);

  function isProviderExpanded(id: string): boolean {
    if (modelSearch.trim()) {
      return modelsForProvider(id).length > 0 || expandedProviders[id] === true;
    }
    if (expandedProviders[id] !== undefined) return expandedProviders[id];
    return id === appStore.activeProviderName;
  }

  function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), ms);
      promise.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e) => {
          clearTimeout(t);
          reject(e);
        }
      );
    });
  }

  async function loadModelsForProvider(id: string, force = false) {
    if (loadingProvider[id]) return;
    if (!force && modelsByProvider[id] !== undefined) return;

    // Instant seed so UI never sits on an empty/infinite loader
    const seeded = seedModels(id);
    if (seeded.length && modelsByProvider[id] === undefined) {
      modelsByProvider = { ...modelsByProvider, [id]: seeded };
    }

    const saved = appStore.config.llm?.providers?.[id];
    const baseUrl = saved?.base_url || defaultBaseUrl(id);

    // A provider with no key cannot list models, and asking anyway makes the
    // main process log a handler error on every start. The seeded list above
    // is already what the user sees, so there is nothing to gain by calling.
    // Keyless local runtimes (llama.cpp, Ollama, LM Studio) still get queried.
    const hasKey = !!(saved?.has_api_key || saved?.api_key);
    const isLocal = id === 'local' || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(baseUrl);
    if (!hasKey && !isLocal) return;

    loadingProvider = { ...loadingProvider, [id]: true };
    providerErrors = { ...providerErrors, [id]: '' };

    try {
      // Empty key → main process resolves stored secret by providerName
      const ids = await withTimeout(
        invoke<string[]>('fetch_provider_models', {
          baseUrl,
          apiKey: '',
          providerName: id
        }),
        12_000
      );
      let list: ModelOption[] = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id.trim()))].map((mid) => ({
        id: String(mid),
        name: String(mid),
        source: 'api' as const
      }));
      if (!list.length) list = seedModels(id);
      modelsByProvider = { ...modelsByProvider, [id]: list };
    } catch {
      providerErrors = { ...providerErrors, [id]: 'Could not refresh models. Your saved model is still available.' };
      // Keep seed / previous list — never leave empty-loading state
      if (modelsByProvider[id] === undefined) {
        modelsByProvider = { ...modelsByProvider, [id]: seedModels(id) };
      }
    } finally {
      loadingProvider = { ...loadingProvider, [id]: false };
    }
  }

  function toggleProvider(id: string) {
    const nextOpen = !isProviderExpanded(id);
    expandedProviders = { ...expandedProviders, [id]: nextOpen };
    if (nextOpen) void loadModelsForProvider(id);
  }

  async function selectCloudModel(providerId: string, modelId: string) {
    if (selectingModel || changingMode) return;
    if (providerId === appStore.activeProviderName && modelId === activeProvider?.model) {
      appStore.modelMenuOpen = false;
      return;
    }
    selectingModel = `${providerId}/${modelId}`;
    const saved = appStore.config.llm?.providers?.[providerId];
    try {
      await appStore.updateProvider({
        provider: providerId,
        base_url: saved?.base_url || defaultBaseUrl(providerId),
        model: modelId
      });
    } catch (err) {
      toastStore.error('Could not switch model');
      return;
    } finally {
      selectingModel = '';
    }
    appStore.modelMenuOpen = false;
  }

  async function changeBackend(mode: string) {
    if (changingMode || selectingModel || mode === appStore.backendMode) return;
    changingMode = true;
    try {
      await appStore.setBackendMode(mode as 'api' | 'local');
      initCloudListWhenOpen();
    } catch {
      toastStore.error('Could not change model source. Please try again.');
    } finally {
      changingMode = false;
    }
  }

  /** Portal fixed menus out of the titlebar drag region so clicks work on Windows/Electron. */
  function portalToBody(node: HTMLElement) {
    document.body.appendChild(node);
    return {
      destroy() {
        if (node.parentNode) node.parentNode.removeChild(node);
      }
    };
  }

  function isLoaded(model: Pick<ModelOption, 'id' | 'name' | 'path'>) {
    if (!appStore.localModelActive) return false;
    const activePath = loadedModelPath;
    const activeName = loadedModelName.toLowerCase();
    const p = String(model.path || '').toLowerCase();
    const n = String(model.name || model.id || '').toLowerCase();
    return (
      (activePath && activePath === p) ||
      activeName === n ||
      activeName.includes(n) ||
      n.includes(activeName)
    );
  }

  function isLoadingModel(model: Pick<ModelOption, 'id'>) {
    return !!(localLoading && appStore.localModelLoadTarget?.id === model.id);
  }

  function modelStatusLabel(model: ModelOption) {
    if (isLoaded(model)) return 'Loaded';
    if (isLoadingModel(model)) return 'Loading';
    return 'Available';
  }

  function secondaryText(model: ModelOption) {
    return buildLocalModelSecondaryText(model);
  }

  function contextBadge(model: ModelOption) {
    const value = formatContextLength(model.context_length);
    return value ? `${value} ctx` : '';
  }

  function metaLine(model: ModelOption) {
    const parts = [
      secondaryText(model),
      contextBadge(model),
      model.has_mmproj ? 'vision' : '',
      model.chat_template_uses_tools === true ? 'tools' : '',
      modelStatusLabel(model).toLowerCase()
    ]
      .filter(Boolean);
    return parts.join(' • ');
  }

  async function handleLoad(model: ModelOption) {
    if (isAnyModelLoaded && !isLoaded(model)) {
      confirmSwitch = model;
      return;
    }
    await appStore.openLocalModelLoadDialog(model);
    appStore.modelMenuOpen = false;
  }

  async function handleUnload(e: MouseEvent) {
    e.stopPropagation();
    if (unloading) return;
    unloading = true;
    try {
      await appStore.stopLocalModel();
      toastStore.success('Model unloaded');
    } catch {
      toastStore.error('Failed to unload model');
    } finally {
      unloading = false;
    }
  }

  async function confirmSwitchModel() {
    if (!confirmSwitch) return;
    const model = confirmSwitch;
    confirmSwitch = null;
    appStore.modelMenuOpen = false;
    await appStore.openLocalModelLoadDialog(model);
  }

  function toggleMenu() {
    if (appStore.modelMenuOpen) {
      appStore.modelMenuOpen = false;
      return;
    }
    appStore.modelMenuOpen = true;
  }

  function initCloudListWhenOpen() {
    // Must not be tracked by the open/close effect (would re-run forever).
    untrack(() => {
      if (appStore.backendMode !== 'api') return;
      const active = appStore.activeProviderName;
      if (!active) return;
      expandedProviders = { ...expandedProviders, [active]: true };
      void loadModelsForProvider(active);
    });
  }

  // Stable open/close: only depend on modelMenuOpen — never write expanded/models here without untrack.
  $effect(() => {
    const open = appStore.modelMenuOpen;
    if (!open) {
      modelSearch = '';
      confirmSwitch = null;
      return;
    }

    initCloudListWhenOpen();
    // Focus search once the modal lands.
    const focusTimer = window.setTimeout(() => searchInput?.focus(), 60);

    function handleKeydown(event: KeyboardEvent) {
      if (!panelEl) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        appStore.modelMenuOpen = false;
        return;
      }
      if (event.key === 'Tab') {
        const focusable = [...panelEl.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')];
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && (document.activeElement === first || !panelEl.contains(document.activeElement))) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !panelEl.contains(document.activeElement))) {
          event.preventDefault(); first?.focus();
        }
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const rows = [...panelEl.querySelectorAll<HTMLButtonElement>('[data-model-option]:not(:disabled)')];
        const current = rows.findIndex((row) => row === document.activeElement);
        if (document.activeElement !== searchInput && current < 0) return;
        event.preventDefault();
        const next = current + (event.key === 'ArrowDown' ? 1 : -1);
        if (next < 0 && current >= 0) searchInput?.focus();
        else {
          const row = rows[Math.min(rows.length - 1, Math.max(0, next))];
          row?.focus(); row?.scrollIntoView({ block: 'nearest' });
        }
      }
    }
    document.addEventListener('keydown', handleKeydown);
    return () => {
      clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeydown);
      triggerEl?.focus();
    };
  });

  // Search all configured providers, including groups that haven't been opened.
  $effect(() => {
    if (!appStore.modelMenuOpen || appStore.backendMode !== 'api' || !modelSearch.trim()) return;
    const timer = setTimeout(() => untrack(() => {
      for (const provider of configured) void loadModelsForProvider(provider.id);
    }), 180);
    return () => clearTimeout(timer);
  });
</script>

<!-- Trigger: compact model selector -->
<button
  bind:this={triggerEl}
  type="button"
  class="model-trigger titlebar-no-drag flex h-8 max-w-[18rem] items-center gap-1.5 px-2.5 transition"
  class:is-open={appStore.modelMenuOpen}
  style="-webkit-app-region: no-drag; pointer-events: auto;"
  onclick={toggleMenu}
  aria-haspopup="dialog"
  aria-expanded={appStore.modelMenuOpen}
  aria-controls={dialogId}
  aria-label={`Choose model: ${displayLabel || 'On device'}`}
>
  {#if appStore.backendMode === 'local'}
    <Cpu class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
  {:else}
    <ProviderIcon provider={appStore.activeProviderName} size={15} />
  {/if}
  <span class="trigger-label truncate">
    {#if appStore.backendMode === 'local' && isAnyModelLoaded}
      {loadedModelFilename}
    {:else if appStore.backendMode === 'local'}
      On Device
    {:else}
      {displayLabel || 'Select model'}
    {/if}
  </span>
  <ChevronDown class="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150 {appStore.modelMenuOpen ? 'rotate-180' : ''}" />
</button>

<!-- Modal: portaled to body so Electron titlebar drag region cannot swallow clicks.
     Gray backdrop fills the window; square panel sits centered with fade/scale. -->
{#if appStore.modelMenuOpen}
  <div use:portalToBody class="model-modal-root fixed inset-0">
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div
      class="model-modal-backdrop absolute inset-0"
      onclick={() => (appStore.modelMenuOpen = false)}
      transition:motionFade={{ duration: 160 }}
    ></div>
    <div class="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div
        bind:this={panelEl}
        id={dialogId}
        class="model-modal pointer-events-auto flex max-h-full min-h-0 flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${dialogId}-title`}
        tabindex="-1"
        onclick={(e) => e.stopPropagation()}
        onpointerdown={(e) => e.stopPropagation()}
        transition:flyAndScale={{ y: 10, start: 0.96, duration: 180 }}
       >
    <header class="picker-heading">
      <div><h2 id={`${dialogId}-title`}>Choose a model</h2><p>The right model for your next conversation.</p></div>
      <button type="button" class="aui-icon-button size-8" onclick={() => (appStore.modelMenuOpen = false)} aria-label="Close model picker"><X class="size-4" /></button>
    </header>
    <div class="picker-source">
      {#if isElectron()}
        <SegmentedControl value={appStore.backendMode} options={[{ value: 'api', label: 'Cloud', disabled: changingMode || !!selectingModel }, { value: 'local', label: 'On device', disabled: changingMode || !!selectingModel }]} label="Model source" onchange={(mode) => void changeBackend(mode)} />
      {/if}
      <span class="source-caption">{appStore.backendMode === 'local' ? 'Runs on your computer' : 'Your connected providers'}</span>
    </div>
    <!-- Search stays anchored while provider groups scroll below it. -->
    <div class="panel-head flex items-center gap-1.5 px-2.5 pb-2 pt-2.5">
      <div class="search-wrapper relative min-w-0 flex-1">
        <Search class="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          bind:this={searchInput}
          bind:value={modelSearch}
           type="search"
           aria-label="Search models"
          placeholder="Search models…"
          class="search-input w-full py-1.5 pl-9 pr-9 text-[13px] text-foreground outline-none transition placeholder:text-muted-foreground"
          onclick={(e) => e.stopPropagation()}
          onkeydown={(e) => e.key === 'Escape' && (appStore.modelMenuOpen = false)}
        />
        {#if modelSearch}
          <button
             class="clear-btn absolute right-2.5 top-1/2 -translate-y-1/2 p-1"
             aria-label="Clear model search"
            onclick={() => (modelSearch = '')}
          >
            <X class="h-3.5 w-3.5" />
          </button>
        {/if}
      </div>
      {#if appStore.backendMode === 'api'}
        <Tooltip label="Refresh models" position="bottom">
          <button
            type="button"
            class="mode-icon-btn shrink-0"
            onclick={() => {
              appStore.refreshModels(true);
              modelsStore.refreshStatus();
              const active = appStore.activeProviderName;
              if (active) void loadModelsForProvider(active, true);
            }}
            aria-label="Refresh models"
            disabled={!!loadingProvider[appStore.activeProviderName]}
          >
            <RefreshCw class="h-4 w-4 {loadingProvider[appStore.activeProviderName] ? 'animate-spin' : ''}" />
          </button>
        </Tooltip>
        <Tooltip label="Manage API providers" position="bottom">
          <button
            type="button"
            class="mode-icon-btn shrink-0"
            onclick={() => {
              appStore.modelMenuOpen = false;
              appStore.modelManagerOpenSection = 'providers';
              appStore.modelManagerOpen = true;
            }}
            aria-label="Manage API providers"
          >
            <Settings2 class="h-4 w-4" />
          </button>
        </Tooltip>
      {:else}
        <Tooltip label="Refresh models" position="bottom">
          <button
            type="button"
            class="mode-icon-btn shrink-0"
            onclick={() => {
              appStore.refreshModels(true);
              modelsStore.refreshStatus();
              if (isElectron()) modelsStore.refreshIndex();
            }}
            aria-label="Refresh models"
            disabled={appStore.modelsRefreshing}
          >
            <RefreshCw class="h-4 w-4 {appStore.modelsRefreshing ? 'animate-spin' : ''}" />
          </button>
        </Tooltip>
      {/if}
    </div>

    <!-- Runtime busy -->
    {#if appStore.backendMode === 'local' && localLoading}
      <div class="loading-indicator mx-3 mb-2.5 flex items-center gap-2 px-2.5 py-2">
        <LoaderCircle class="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
        <span class="text-sm font-medium text-fg-secondary">Loading model...</span>
      </div>
    {/if}

    <!-- Switch confirmation -->
    {#if confirmSwitch}
      <div class="confirm-card mx-3 mb-2.5 p-2.5">
        <p class="text-[12px] text-fg-secondary">
          Unload <span class="font-semibold text-foreground">{loadedModelFilename}</span> and load <span class="font-semibold text-foreground">{confirmSwitch.name}</span>?
        </p>
        <div class="mt-3 flex gap-2">
          <button
            class="confirm-btn primary flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold"
            onclick={confirmSwitchModel}
          >
            <Power class="h-3.5 w-3.5" />
            Switch
          </button>
          <button
            class="confirm-btn secondary px-3 py-1.5 text-sm font-medium"
            onclick={() => (confirmSwitch = null)}
          >Cancel</button>
        </div>
      </div>
    {/if}

    <!-- Model list -->
    <div class="model-list min-h-0 flex-1 overflow-y-auto px-2 pb-2.5" aria-label="Available models" aria-busy={changingMode}>
      {#if appStore.backendMode === 'api'}
        {#if !configured.length}
          <div class="empty-state flex flex-col items-center gap-3 px-4 py-6 text-center">
            <div class="empty-icon flex h-10 w-10 items-center justify-center">
              <Sparkles class="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <p class="text-sm font-medium text-fg-secondary">No providers configured</p>
              <p class="mt-0.5 text-xs text-muted-foreground">Add an API key in Settings → API</p>
            </div>
            <Button
              size="sm"
              class="text-xs"
              onclick={() => {
                appStore.modelMenuOpen = false;
                appStore.modelManagerOpenSection = 'providers';
                appStore.modelManagerOpen = true;
              }}
            >
              Configure Provider
            </Button>
          </div>
        {:else if !visibleProviders.length}
          <div class="picker-empty"><Search class="size-5" /><p>No models found</p><span>Try a model name or a provider.</span><button type="button" onclick={() => (modelSearch = '')}>Clear search</button></div>
        {:else}
          <!-- Nested tree: provider → models (no card borders) -->
          <div class="provider-tree space-y-0.5 px-0.5">
            {#each visibleProviders as prov (prov.id)}
              {@const open = isProviderExpanded(prov.id)}
              {@const list = modelsForProvider(prov.id)}
              {@const loading = !!loadingProvider[prov.id]}
              <div class="provider-node">
                <button
                  type="button"
                  class="provider-row flex w-full items-center gap-2 rounded-full px-2.5 py-1.5 text-left transition hover:bg-muted/60"
                  style="-webkit-app-region: no-drag; pointer-events: auto;"
                   onclick={(e) => {
                    e.stopPropagation();
                    toggleProvider(prov.id);
                   }}
                   aria-expanded={open}
                 >
                  <span class="provider-mark"><ProviderIcon provider={prov.id} size={18} /></span>
                  <ChevronDown
                    class="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150 {open
                      ? 'rotate-0'
                      : '-rotate-90'}"
                  />
                  <span class="min-w-0 flex-1">
                    <span class="flex items-center gap-1.5">
                      <span class="text-[13px] font-medium text-foreground">{prov.label}</span>
                      {#if prov.isActive}
                        <span class="provider-active">Connected</span>
                      {/if}
                    </span>
                    {#if prov.model && !open}
                      <span class="mt-0.5 block truncate text-[12px] text-muted-foreground">{prov.model}</span>
                    {/if}
                  </span>
                  {#if loading}
                    <LoaderCircle class="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
                  {/if}
                </button>

                {#if open}
                  <!-- No indent rail: the provider header above already groups
                       these, so the rail was chrome restating the hierarchy. -->
                  <div class="model-nest">
                    {#if providerErrors[prov.id]}
                      <div class="provider-error" role="status"><span>{providerErrors[prov.id]}</span><button type="button" disabled={loading} onclick={() => void loadModelsForProvider(prov.id, true)}>Retry</button></div>
                    {/if}
                    {#if list.length === 0 && loading}
                      <div class="flex items-center gap-2 px-2 py-1.5 text-[11px] text-muted-foreground">
                        <LoaderCircle class="h-3 w-3 animate-spin" />
                        Loading…
                      </div>
                    {:else if list.length === 0}
                      <div class="px-2 py-1.5 text-[11px] text-muted-foreground">
                        {modelSearch ? 'No matches' : 'No models — open API settings or refresh'}
                      </div>
                    {:else}
                      {#each list as model (model.id)}
                        {@const selected =
                          appStore.activeProviderName === prov.id && activeProvider?.model === model.id}
                        <button
                          type="button"
                          class="model-row flex w-full items-center gap-2 rounded-full px-2.5 py-1.5 text-left transition hover:bg-muted/60"
                           class:is-selected={selected}
                           data-model-option
                           aria-pressed={selected}
                           disabled={!!selectingModel || changingMode}
                           title={model.id}
                          style="-webkit-app-region: no-drag; pointer-events: auto;"
                          onclick={(e) => {
                            e.stopPropagation();
                            void selectCloudModel(prov.id, model.id);
                          }}
                        >
                          {#if selectingModel === `${prov.id}/${model.id}`}
                            <LoaderCircle class="h-3.5 w-3.5 shrink-0 animate-spin" />
                          {:else if selected}
                            <Check class="h-3.5 w-3.5 shrink-0 text-fg-secondary" />
                          {:else}
                            <span class="inline-block w-3.5 shrink-0"></span>
                          {/if}
                          <span class="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground"
                            >{model.name}</span
                           >
                          {#if selected}<span class="selected-label">In use</span>{/if}
                        </button>
                      {/each}
                    {/if}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      {:else if !appStore.models.length}
        <div class="empty-state flex flex-col items-center gap-2 px-4 py-6 text-center">
          <div>
            <p class="text-sm font-semibold text-foreground">No local models</p>
            <p class="mt-1 text-xs text-fg-secondary">Discover and download one in Explore</p>
          </div>
          <Button
            size="sm"
            class="text-xs"
            onclick={() => {
              appStore.modelMenuOpen = false;
              appStore.modelManagerOpenSection = 'explore';
              appStore.modelManagerOpen = true;
            }}
          >
            Explore models
          </Button>
        </div>
      {:else if filteredModels.length === 0}
        <div class="px-4 py-6 text-center">
          <p class="text-sm text-muted-foreground">No models match your search</p>
        </div>
      {:else}
        <div class="space-y-0.5">
          {#each filteredModels as model (model.id)}
            {@const loaded = isLoaded(model)}
            {@const loadingTarget = isLoadingModel(model)}

            <div
              class="model-item group flex w-full items-center gap-2 rounded-xl px-2 py-1.5 transition hover:bg-muted/60 {loaded ? 'bg-muted/60' : ''}"
            >
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5">
                  <span class="truncate text-[12px] font-medium text-foreground">{model.name}</span>
                </div>
                {#if metaLine(model)}
                  <div class="mt-0.5 truncate text-[11px] text-muted-foreground">{metaLine(model)}</div>
                {/if}
              </div>

              {#if model.path}
                {#if loaded}
                  <Button
                    variant="ghost"
                    size="sm"
                    class="shrink-0 text-xs text-error"
                    onclick={handleUnload}
                    disabled={unloading}
                  >
                    {#if unloading}
                      <LoaderCircle class="h-3.5 w-3.5 animate-spin" />
                    {:else}
                      <Square class="h-3.5 w-3.5" />
                    {/if}
                    Unload
                  </Button>
                {:else}
                  <Button
                    variant="ghost"
                    size="sm"
                    class="shrink-0 text-xs"
                    onclick={async (e) => {
                      e.stopPropagation();
                      await handleLoad(model);
                    }}
                    disabled={localLoading}
                    data-model-option
                  >
                    {#if loadingTarget}
                      <LoaderCircle class="h-3.5 w-3.5 animate-spin" />
                      Loading
                    {:else}
                      <Play class="h-3.5 w-3.5" />
                      Load
                    {/if}
                  </Button>
                {/if}
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
    <footer class="picker-footer"><span aria-live="polite">{resultCount} {resultCount === 1 ? 'model' : 'models'}{modelSearch ? ' found' : ' available'}</span><span class="picker-key-hint"><kbd>↑</kbd><kbd>↓</kbd> Navigate <kbd>esc</kbd> Close</span></footer>
  </div>
    </div>
  </div>
{/if}

<style>
  /* A white pill with a hairline border, matching the add button beside it and
     the suggestion chips below the composer. */
  .model-trigger {
    color: var(--text-secondary);
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    box-shadow: none;
    transition:
      background-color var(--motion-fast) var(--motion-ease),
      border-color var(--motion-fast) var(--motion-ease),
      color var(--motion-fast) var(--motion-ease);
  }

  .model-trigger:hover,
  .model-trigger.is-open {
    border-color: color-mix(in srgb, var(--foreground) 22%, transparent);
    background: var(--muted);
    color: var(--foreground);
  }

  .trigger-label {
    color: inherit;
    font-size: 0.8125rem;
    font-weight: 500;
    letter-spacing: -0.01em;
  }

  /* Centered modal over a gray backdrop. Square-ish card sized to
     content, capped to the window. */
  .model-modal-root {
    z-index: 10050;
    -webkit-app-region: no-drag;
  }

  .model-modal-backdrop {
    background: var(--overlay);
  }

  .model-modal {
    width: min(520px, calc(100vw - 32px));
    height: min(640px, calc(100dvh - 64px));
    max-height: calc(100dvh - 32px);
    background: var(--card);
    border: 0;
    border-radius: var(--radius-2xl);
    box-shadow:
      inset 0 0 0 1px var(--composer-ring),
      var(--shadow-xl);
    -webkit-app-region: no-drag;
    pointer-events: auto;
  }

  /* Segmented track: outline instead of a filled pill track. */
  .model-modal :global(.aui-segmented) {
    background: transparent;
    box-shadow: inset 0 0 0 1px var(--border);
  }

  .model-modal :global(.aui-segmented-item.is-active) {
    background: var(--muted);
  }

  .model-modal button,
  .model-modal input {
    -webkit-app-region: no-drag;
    pointer-events: auto;
    cursor: pointer;
  }

  .model-modal input {
    cursor: text;
  }

  .mode-icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    color: var(--muted-foreground);
    background: transparent;
    border: none;
    border-radius: var(--radius-md);
  }

  .mode-icon-btn:hover {
    color: var(--foreground);
    background: var(--muted);
  }

  .mode-icon-btn.is-active {
    color: var(--foreground);
    background: var(--muted);
  }

  .loading-indicator {
    background: transparent;
    border: none;
  }

  .confirm-card {
    background: var(--muted);
    border: none;
    border-radius: var(--radius-lg);
  }

  .confirm-btn.primary {
    background: var(--primary);
    color: var(--primary-foreground);
    border: none;
    border-radius: var(--radius-full);
  }

  .confirm-btn.primary:hover {
    opacity: 0.9;
  }

  .confirm-btn.secondary {
    background: transparent;
    color: var(--muted-foreground);
    border: none;
    border-radius: var(--radius-full);
  }

  .confirm-btn.secondary:hover {
    color: var(--foreground);
    background: color-mix(in srgb, var(--foreground) 6%, transparent);
  }

  .search-wrapper .search-input {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
  }

  .provider-tree {
    padding-bottom: 0.25rem;
  }

  .provider-row {
    border: none;
    background: transparent;
    border-radius: var(--radius-full);
    transition: background-color var(--motion-fast) var(--motion-ease);
  }

  .model-nest {
    margin-top: 0.1rem;
    margin-bottom: 0.35rem;
  }

  .model-row {
    border: none;
    background: transparent;
    border-radius: var(--radius-lg);
    min-height: 2.5rem;
    padding-inline: 0.8rem;
    transition: background-color var(--motion-fast) var(--motion-ease);
  }

  .model-row.is-selected {
    background: var(--surface-active);
    box-shadow: inset 0 0 0 1px var(--border-subtle);
  }

  .search-wrapper .search-input:focus {
    background: var(--background);
    border-color: var(--ring);
    box-shadow: 0 0 0 2px color-mix(in oklch, var(--ring) 25%, transparent);
  }

  .clear-btn {
    color: var(--muted-foreground);
    background: transparent;
    border: none;
    border-radius: var(--radius-md);
  }

  .clear-btn:hover {
    color: var(--foreground);
    background: var(--muted);
  }

  .empty-icon {
    background: var(--muted);
    border: none;
    border-radius: 8px;
  }

  .picker-heading { display: flex; align-items: center; justify-content: space-between; padding: 1.1rem 1.15rem 0.9rem; gap: 1rem; }
  .picker-heading h2 { margin: 0; font-size: 1rem; font-weight: 600; letter-spacing: -0.025em; color: var(--foreground); }
  .picker-heading p { margin: 0.3rem 0 0; font-size: 0.75rem; color: var(--muted-foreground); }
  .picker-source { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0 1rem 0.6rem; }
  .source-caption { font-size: 11px; color: var(--muted-foreground); }
  .panel-head { border-bottom: 1px solid var(--border-subtle); padding: 0.45rem 1rem 0.8rem; }
  .search-wrapper .search-input { height: 2.5rem; background: var(--surface); }
  .search-input::-webkit-search-cancel-button { display: none; }
  .model-list { padding-top: 0.6rem; scrollbar-gutter: stable; overscroll-behavior: contain; }
  .provider-row { min-height: 2.75rem; }
  .provider-mark { display: flex; align-items: center; justify-content: center; width: 1.8rem; height: 1.8rem; border-radius: var(--radius-md); background: var(--surface); }
  .provider-active, .selected-label { flex-shrink: 0; font-size: 10px; font-weight: 500; color: var(--muted-foreground); }
  .selected-label { padding: 0.2rem 0.45rem; border-radius: var(--radius-full); background: var(--background); }
  .model-nest { margin: 0.1rem 0.3rem 0.6rem; }
  .model-row:disabled { cursor: wait; opacity: 0.65; }
  .model-item { min-height: 3.25rem; padding: 0.6rem; }
  .model-trigger:focus-visible, .model-modal button:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
  .picker-footer { display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.8rem 1rem; border-top: 1px solid var(--border-subtle); font-size: 11px; color: var(--muted-foreground); }
  .picker-key-hint { display: inline-flex; align-items: center; gap: 0.25rem; }
  .picker-key-hint kbd { padding: 1px 4px; border: 1px solid var(--border-subtle); border-radius: 4px; font: inherit; }
  .picker-empty { display: flex; align-items: center; flex-direction: column; padding: 2.5rem 1rem; gap: 0.5rem; color: var(--muted-foreground); font-size: 12px; }
  .picker-empty p { font-size: 14px; font-weight: 500; color: var(--foreground); }
  .picker-empty button, .provider-error button { color: var(--foreground); text-decoration: underline; text-underline-offset: 3px; background: transparent; border: 0; }
  .provider-error { display: flex; align-items: center; gap: 0.6rem; padding: 0.6rem; font-size: 11px; color: var(--muted-foreground); }
  @media (max-width: 480px) { .source-caption, .picker-key-hint { display: none; } .model-modal { height: min(640px, calc(100dvh - 32px)); } }
</style>

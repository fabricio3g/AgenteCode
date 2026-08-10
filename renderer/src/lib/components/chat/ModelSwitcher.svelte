<svelte:options runes={true} />

<script lang="ts">
  import { untrack } from 'svelte';
  import { Check, ChevronDown, Cloud, Cpu, LoaderCircle, Play, Power, RefreshCw, Search, Sparkles, Square, X } from 'lucide-svelte';
  import { motionFade } from '$lib/utils/transitions';
  import { appStore } from '$lib/stores/app.svelte';
  import { modelsStore } from '$lib/stores/models.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { invoke, isTauri } from '$lib/services/tauri';
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
  let dropdownEl: HTMLDivElement | undefined = $state();
  let modelSearch = $state('');
  let searchInput = $state<HTMLInputElement | undefined>(undefined);
  let searchExpanded = $state(false);
  let unloading = $state(false);
  let confirmSwitch = $state<ModelOption | null>(null);
  let dropdownPos = $state({ top: 0, left: 0, width: 320 });
  /** Cloud: models cached per provider id (`undefined` = not loaded yet) */
  let modelsByProvider = $state<Record<string, ModelOption[] | undefined>>({});
  let loadingProvider = $state<Record<string, boolean>>({});
  let expandedProviders = $state<Record<string, boolean>>({});
  let loadGen = $state(0);

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
    if (!q) return list;
    return list.filter((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
  }

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

    const gen = ++loadGen;
    const saved = appStore.config.llm?.providers?.[id];
    const baseUrl = saved?.base_url || defaultBaseUrl(id);
    loadingProvider = { ...loadingProvider, [id]: true };

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
      if (gen !== loadGen && !force) {
        // stale; still apply if this id is still relevant
      }
      let list: ModelOption[] = (Array.isArray(ids) ? ids : []).map((mid) => ({
        id: String(mid),
        name: String(mid),
        source: 'api' as const
      }));
      if (!list.length) list = seedModels(id);
      modelsByProvider = { ...modelsByProvider, [id]: list };
    } catch {
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
    }
    appStore.modelMenuOpen = false;
  }

  function openSearch() {
    searchExpanded = true;
    setTimeout(() => searchInput?.focus(), 30);
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

  function updateDropdownPos() {
    if (!triggerEl) return;
    const rect = triggerEl.getBoundingClientRect();
    const w = Math.min(360, window.innerWidth - 32);
    dropdownPos = {
      top: rect.bottom + 6,
      left: Math.max(16, rect.left + rect.width / 2 - w / 2),
      width: w,
    };
  }

  function toggleMenu() {
    if (appStore.modelMenuOpen) {
      appStore.modelMenuOpen = false;
      return;
    }
    updateDropdownPos();
    appStore.modelMenuOpen = true;
  }

  function initCloudListWhenOpen() {
    // Must not be tracked by the open/close effect (would re-run forever).
    untrack(() => {
      if (appStore.backendMode !== 'api') return;
      const active = appStore.activeProviderName;
      if (!active) return;
      expandedProviders = { ...expandedProviders, [active]: true };
      if (appStore.models.length && modelsByProvider[active] === undefined) {
        modelsByProvider = { ...modelsByProvider, [active]: appStore.models.slice() };
      }
      void loadModelsForProvider(active);
    });
  }

  // Stable open/close: only depend on modelMenuOpen — never write expanded/models here without untrack.
  $effect(() => {
    const open = appStore.modelMenuOpen;
    if (!open) {
      modelSearch = '';
      searchExpanded = false;
      confirmSwitch = null;
      return;
    }

    updateDropdownPos();
    initCloudListWhenOpen();

    function handleClickOutside(event: PointerEvent) {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      if (triggerEl && (path.includes(triggerEl) || triggerEl.contains(event.target as Node))) return;
      if (dropdownEl && (path.includes(dropdownEl) || dropdownEl.contains(event.target as Node))) return;
      appStore.modelMenuOpen = false;
    }
    function handleResize() {
      updateDropdownPos();
    }

    // Defer so the opening click cannot dismiss the freshly opened menu
    const timer = window.setTimeout(() => {
      document.addEventListener('pointerdown', handleClickOutside, true);
    }, 10);
    window.addEventListener('resize', handleResize);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', handleClickOutside, true);
      window.removeEventListener('resize', handleResize);
    };
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
>
  {#if appStore.backendMode === 'local'}
    <Cpu class="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
  {:else}
    <Cloud class="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
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
  <ChevronDown class="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)] transition-transform duration-150 {appStore.modelMenuOpen ? 'rotate-180' : ''}" />
</button>

<!-- Dropdown: portaled to body so Electron titlebar drag region cannot swallow clicks -->
{#if appStore.modelMenuOpen}
  <div
    bind:this={dropdownEl}
    use:portalToBody
    class="model-dropdown fixed overflow-hidden"
    style="top:{dropdownPos.top}px; left:{dropdownPos.left}px; width:{dropdownPos.width}px; z-index:10050; -webkit-app-region: no-drag; pointer-events: auto;"
    role="listbox"
    tabindex="-1"
    onpointerdown={(e) => e.stopPropagation()}
    transition:motionFade={{ duration: 100 }}
  >
    <!-- Header -->
    <div class="flex items-center justify-between gap-2 px-3 pt-2.5 pb-2">
      <span class="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">
        {appStore.backendMode === 'local' ? 'On Device Models' : 'Cloud Models'}
      </span>
      <div class="flex items-center gap-0.5">
        {#if appStore.backendMode === 'api'}
          <button
            type="button"
            class="refresh-btn p-1.5"
            onclick={openSearch}
            aria-label="Search models"
            title="Search models"
          >
            <Search class="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            class="refresh-btn p-1.5"
            onclick={() => {
              appStore.refreshModels(true);
              modelsStore.refreshStatus();
              const active = appStore.activeProviderName;
              if (active) void loadModelsForProvider(active, true);
            }}
            aria-label="Refresh"
          >
            <RefreshCw class="h-3.5 w-3.5" />
          </button>
        {:else}
          <button
            type="button"
            class="refresh-btn p-1.5"
            onclick={openSearch}
            aria-label="Search models"
          >
            <Search class="h-3.5 w-3.5" />
          </button>
        {/if}
      </div>
    </div>

    <!-- Cloud / On Device mode toggle -->
    {#if isTauri()}
      <div class="aui-segmented mx-3 mb-2.5 w-[calc(100%-1.5rem)]" style="-webkit-app-region: no-drag;">
        <button
          type="button"
          class={`aui-segmented-item flex-1 py-1.5 ${appStore.backendMode === 'api' ? 'is-active' : ''}`}
          style="-webkit-app-region: no-drag; pointer-events: auto;"
          onclick={(e) => {
            e.stopPropagation();
            void appStore.setBackendMode('api').then(() => initCloudListWhenOpen());
          }}
        >Cloud</button>
        <button
          type="button"
          class={`aui-segmented-item flex-1 py-1.5 ${appStore.backendMode === 'local' ? 'is-active' : ''}`}
          style="-webkit-app-region: no-drag; pointer-events: auto;"
          onclick={(e) => {
            e.stopPropagation();
            void appStore.setBackendMode('local');
          }}
        >On Device</button>
      </div>
    {/if}

    <!-- Runtime busy -->
    {#if appStore.backendMode === 'local' && localLoading}
      <div class="loading-indicator mx-3 mb-2.5 flex items-center gap-2 px-2.5 py-2">
        <LoaderCircle class="h-4 w-4 shrink-0 animate-spin text-[var(--text-muted)]" />
        <span class="text-sm font-medium text-[var(--text-secondary)]">Loading model...</span>
      </div>
    {/if}

    <!-- Switch confirmation -->
    {#if confirmSwitch}
      <div class="confirm-card mx-3 mb-2.5 p-2.5">
        <p class="text-[12px] text-[var(--text-secondary)]">
          Unload <span class="font-semibold text-[var(--text)]">{loadedModelFilename}</span> and load <span class="font-semibold text-[var(--text)]">{confirmSwitch.name}</span>?
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

    <!-- Search: always for cloud; local when opened or typing -->
    {#if searchExpanded || appStore.backendMode === 'api' || appStore.backendMode === 'local' || modelSearch}
      <div class="search-wrapper relative mx-3 mb-2.5">
        <Search class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
        <input
          bind:this={searchInput}
          bind:value={modelSearch}
          type="text"
          placeholder="Search models..."
          class="search-input w-full py-2 pl-10 pr-10 text-sm text-[var(--text)] outline-none transition placeholder:text-[var(--text-muted)]"
          onclick={(e) => e.stopPropagation()}
          onkeydown={(e) => e.key === 'Escape' && (appStore.modelMenuOpen = false)}
        />
        {#if modelSearch}
          <button
            class="clear-btn absolute right-3 top-1/2 -translate-y-1/2 p-1"
            onclick={() => (modelSearch = '')}
          >
            <X class="h-3.5 w-3.5" />
          </button>
        {/if}
      </div>
    {/if}

    <!-- Model list -->
    <div class="model-list max-h-72 overflow-y-auto px-2 pb-2.5">
      {#if appStore.backendMode === 'api'}
        {#if !configured.length}
          <div class="empty-state flex flex-col items-center gap-3 px-4 py-6 text-center">
            <div class="empty-icon flex h-10 w-10 items-center justify-center">
              <Sparkles class="h-5 w-5 text-[var(--text-muted)]" />
            </div>
            <div>
              <p class="text-sm font-medium text-[var(--text-secondary)]">No providers configured</p>
              <p class="mt-0.5 text-xs text-[var(--text-muted)]">Add an API key in Settings → API</p>
            </div>
            <button
              class="empty-btn inline-flex items-center gap-2 px-4 py-2 text-sm font-medium"
              onclick={() => {
                appStore.modelMenuOpen = false;
                appStore.modelManagerOpenSection = 'providers';
                appStore.modelManagerOpen = true;
              }}
            >
              Configure Provider
            </button>
          </div>
        {:else}
          <!-- Nested tree: provider → models (no card borders) -->
          <div class="provider-tree space-y-0.5 px-0.5">
            {#each configured as prov (prov.id)}
              {@const open = isProviderExpanded(prov.id)}
              {@const list = modelsForProvider(prov.id)}
              {@const loading = !!loadingProvider[prov.id]}
              <div class="provider-node">
                <button
                  type="button"
                  class="provider-row flex w-full items-center gap-2 rounded-full px-2.5 py-1.5 text-left transition hover:bg-[var(--surface-hover)]"
                  style="-webkit-app-region: no-drag; pointer-events: auto;"
                  onclick={(e) => {
                    e.stopPropagation();
                    toggleProvider(prov.id);
                  }}
                >
                  <ChevronDown
                    class="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)] transition-transform duration-150 {open
                      ? 'rotate-0'
                      : '-rotate-90'}"
                  />
                  <span class="min-w-0 flex-1">
                    <span class="flex items-center gap-1.5">
                      <span class="text-[12px] font-semibold text-[var(--text)]">{prov.label}</span>
                      {#if prov.isActive}
                        <span class="text-[10px] font-medium text-[var(--text-muted)]">active</span>
                      {/if}
                    </span>
                    {#if prov.model && !open}
                      <span class="mt-0.5 block truncate pl-0 text-[11px] text-[var(--text-muted)]">{prov.model}</span>
                    {/if}
                  </span>
                  {#if loading}
                    <LoaderCircle class="h-3 w-3 shrink-0 animate-spin text-[var(--text-muted)]" />
                  {/if}
                </button>

                {#if open}
                  <div class="model-nest ml-3 border-l border-[var(--border)]/40 pl-2">
                    {#if list.length === 0 && loading}
                      <div class="flex items-center gap-2 px-2 py-1.5 text-[11px] text-[var(--text-muted)]">
                        <LoaderCircle class="h-3 w-3 animate-spin" />
                        Loading…
                      </div>
                    {:else if list.length === 0}
                      <div class="px-2 py-1.5 text-[11px] text-[var(--text-muted)]">
                        {modelSearch ? 'No matches' : 'No models — open API settings or refresh'}
                      </div>
                    {:else}
                      {#each list as model (model.id)}
                        {@const selected =
                          appStore.activeProviderName === prov.id && activeProvider?.model === model.id}
                        <button
                          type="button"
                          class="model-row flex w-full items-center gap-2 rounded-full px-2.5 py-1.5 text-left transition hover:bg-[var(--surface-hover)]"
                          class:is-selected={selected}
                          style="-webkit-app-region: no-drag; pointer-events: auto;"
                          onclick={(e) => {
                            e.stopPropagation();
                            void selectCloudModel(prov.id, model.id);
                          }}
                        >
                          {#if selected}
                            <Check class="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
                          {:else}
                            <span class="inline-block w-3.5 shrink-0"></span>
                          {/if}
                          <span class="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--text)]"
                            >{model.name}</span
                          >
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
        <div class="empty-state flex flex-col items-center gap-3 px-4 py-6 text-center">
          <div class="empty-icon flex h-10 w-10 items-center justify-center">
            <Sparkles class="h-5 w-5 text-[var(--text-muted)]" />
          </div>
          <div>
            <p class="text-sm font-medium text-[var(--text-secondary)]">No local models</p>
            <p class="mt-0.5 text-xs text-[var(--text-muted)]">Download models from Models</p>
          </div>
          <button
            class="empty-btn inline-flex items-center gap-2 px-4 py-2 text-sm font-medium"
            onclick={() => {
              appStore.modelMenuOpen = false;
              appStore.modelManagerOpen = true;
            }}
          >
            Open Models
          </button>
        </div>
      {:else if filteredModels.length === 0}
        <div class="px-4 py-6 text-center">
          <p class="text-sm text-[var(--text-muted)]">No models match your search</p>
        </div>
      {:else}
        <div class="space-y-0.5">
          {#each filteredModels as model (model.id)}
            {@const loaded = isLoaded(model)}
            {@const loadingTarget = isLoadingModel(model)}

            <div
              class="model-item group flex w-full items-center gap-2 px-2 py-1.5 transition {loaded ? 'is-loaded' : ''}"
            >
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5">
                  <span class="truncate text-[12px] font-medium text-[var(--text)]">{model.name}</span>
                </div>
                {#if metaLine(model)}
                  <div class="mt-0.5 truncate text-[11px] text-[var(--text-muted)]">{metaLine(model)}</div>
                {/if}
              </div>

              {#if model.path}
                {#if loaded}
                  <button
                    type="button"
                    class="action-btn unload inline-flex shrink-0 items-center gap-1 px-2 py-1 text-[11px] font-medium disabled:opacity-50"
                    onclick={handleUnload}
                    disabled={unloading}
                  >
                    {#if unloading}
                      <LoaderCircle class="h-3.5 w-3.5 animate-spin" />
                    {:else}
                      <Square class="h-3.5 w-3.5" />
                    {/if}
                    Unload
                  </button>
                {:else}
                  <button
                    type="button"
                    class="action-btn load inline-flex shrink-0 items-center gap-1 px-2 py-1 text-[11px] font-medium disabled:opacity-40"
                    onclick={async (e) => {
                      e.stopPropagation();
                      await handleLoad(model);
                    }}
                    disabled={localLoading}
                  >
                    {#if loadingTarget}
                      <LoaderCircle class="h-3.5 w-3.5 animate-spin" />
                      Loading
                    {:else}
                      <Play class="h-3.5 w-3.5" />
                      Load
                    {/if}
                  </button>
                {/if}
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Footer -->
    <div class="dropdown-footer space-y-1.5 border-t border-[var(--border)] px-3 py-2">
      {#if appStore.backendMode === 'api'}
        <button
          class="hub-btn flex w-full items-center justify-center gap-2 px-3 py-1.5 text-[12px] font-medium"
          onclick={() => {
            appStore.modelMenuOpen = false;
            appStore.modelManagerOpenSection = 'providers';
            appStore.modelManagerOpen = true;
          }}
        >
          Manage API providers
        </button>
      {:else}
        <button
          class="refresh-footer-btn flex w-full items-center justify-center gap-2 px-3 py-1.5 text-[12px] font-medium"
          onclick={() => {
            appStore.refreshModels(true);
            modelsStore.refreshStatus();
            if (isTauri()) modelsStore.refreshIndex();
          }}
          disabled={appStore.modelsRefreshing}
        >
          {#if appStore.modelsRefreshing}
            <LoaderCircle class="h-3.5 w-3.5 animate-spin" />
            Refreshing...
          {:else}
            <RefreshCw class="h-3.5 w-3.5" />
            Refresh models
          {/if}
        </button>
        <button
          class="hub-btn flex w-full items-center justify-center gap-2 px-3 py-1.5 text-[12px] font-medium"
          onclick={() => {
            appStore.modelMenuOpen = false;
            appStore.modelManagerOpen = true;
          }}>Browse Models</button
        >
      {/if}
    </div>
  </div>
{/if}

<style>
  .model-trigger {
    color: var(--muted-foreground);
    background: transparent;
    border: none;
    border-radius: var(--radius-full);
    box-shadow: none;
    transition:
      background-color var(--motion-fast) var(--motion-ease),
      color var(--motion-fast) var(--motion-ease);
  }

  .model-trigger:hover,
  .model-trigger.is-open {
    background: var(--surface-hover);
    color: var(--foreground);
  }

  .trigger-label {
    color: inherit;
    font-size: 0.8125rem;
    font-weight: 500;
    letter-spacing: -0.01em;
  }

  :global(.dark) .mode-info svg {
    filter: invert(1);
  }

  @keyframes modelDotPulse {
    0%, 100% { transform: scale(1); opacity: 0.8; }
    50% { transform: scale(1.25); opacity: 1; }
  }

  .model-dropdown {
    background: var(--popover);
    border: 1px solid var(--panel-border);
    border-radius: var(--radius-2xl);
    box-shadow: var(--shadow-xl);
    -webkit-app-region: no-drag;
    pointer-events: auto;
  }

  .model-dropdown button,
  .model-dropdown input {
    -webkit-app-region: no-drag;
    pointer-events: auto;
    cursor: pointer;
  }

  .model-dropdown input {
    cursor: text;
  }

  .refresh-btn {
    color: var(--muted-foreground);
    background: transparent;
    border: none;
    border-radius: var(--radius-md);
  }

  .refresh-btn:hover {
    color: var(--foreground);
    background: var(--surface-hover);
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
    background: var(--muted);
    border: 1px solid transparent;
    border-radius: var(--radius-md);
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
    border-radius: var(--radius-full);
    transition: background-color var(--motion-fast) var(--motion-ease);
  }

  .model-row.is-selected {
    background: color-mix(in srgb, var(--foreground) 6%, transparent);
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

  .empty-btn {
    background: var(--primary);
    color: var(--primary-fg);
    border: none;
    border-radius: var(--radius-full);
    transition: opacity var(--motion-fast) var(--motion-ease);
  }

  .empty-btn:hover {
    opacity: 0.88;
  }

  .model-item {
    background: transparent;
    border: none;
    border-radius: var(--radius-full);
    transition: background-color var(--motion-fast) var(--motion-ease);
  }

  .model-item:hover,
  .model-item.is-loaded {
    background: var(--surface-hover);
  }

  :global(.dark) .live-badge {
    color: var(--live-indicator-dark);
    background: var(--success-bg);
  }

  .action-btn {
    background: transparent;
    color: var(--muted-foreground);
    border: none;
    border-radius: var(--radius-full);
    transition: background-color var(--motion-fast) var(--motion-ease);
  }

  .action-btn:hover {
    color: var(--foreground);
    background: var(--surface-hover);
  }

  .action-btn.unload:hover {
    background: var(--error-bg);
    color: var(--error);
  }

  .action-btn.load,
  .refresh-footer-btn,
  .hub-btn {
    color: var(--foreground);
    border: none;
    border-radius: var(--radius-md);
    background: var(--muted);
  }

  .action-btn.load:hover:not(:disabled),
  .refresh-footer-btn:hover:not(:disabled),
  .hub-btn:hover:not(:disabled) {
    background: var(--surface-active);
  }

  .refresh-footer-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>

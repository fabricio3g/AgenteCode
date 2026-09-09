<svelte:options runes={true} />

<script lang="ts">
  import { untrack } from 'svelte';
  import { Check, ChevronDown, Cloud, Cpu, LoaderCircle, Play, Power, RefreshCw, Search, Settings2, Sparkles, Square, X } from 'lucide-svelte';
  import { flyAndScale, motionFade } from '$lib/utils/transitions';
  import { appStore } from '$lib/stores/app.svelte';
  import { modelsStore } from '$lib/stores/models.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { invoke, isElectron } from '$lib/services/bridge';
  import { Button } from '$lib/components/ui';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
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

    // A provider with no key cannot list models, and asking anyway makes the
    // main process log a handler error on every start. The seeded list above
    // is already what the user sees, so there is nothing to gain by calling.
    // Keyless local runtimes (llama.cpp, Ollama, LM Studio) still get queried.
    const hasKey = !!(saved?.has_api_key || saved?.api_key);
    const isLocal = id === 'local' || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(baseUrl);
    if (!hasKey && !isLocal) return;

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
      confirmSwitch = null;
      return;
    }

    initCloudListWhenOpen();
    // Focus search once the modal lands.
    const focusTimer = window.setTimeout(() => searchInput?.focus(), 60);

    function handleKeydown(event: KeyboardEvent) {
      if (event.key === 'Escape') appStore.modelMenuOpen = false;
    }
    document.addEventListener('keydown', handleKeydown);
    return () => {
      clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeydown);
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
    <Cpu class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
  {:else}
    <Cloud class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
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
        class="model-modal pointer-events-auto flex max-h-full min-h-0 flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label="Select model"
        tabindex="-1"
        onclick={(e) => e.stopPropagation()}
        onpointerdown={(e) => e.stopPropagation()}
        transition:flyAndScale={{ y: 10, start: 0.96, duration: 180 }}
      >
    <!-- Toolbar: search plus backend icons. Mode switch lives here as two
         icon buttons with tooltips instead of a full segmented row. -->
    <div class="panel-head flex items-center gap-1.5 px-2.5 pb-2 pt-2.5">
      <div class="search-wrapper relative min-w-0 flex-1">
        <Search class="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          bind:this={searchInput}
          bind:value={modelSearch}
          type="text"
          placeholder="Search models…"
          class="search-input w-full py-1.5 pl-9 pr-9 text-[13px] text-foreground outline-none transition placeholder:text-muted-foreground"
          onclick={(e) => e.stopPropagation()}
          onkeydown={(e) => e.key === 'Escape' && (appStore.modelMenuOpen = false)}
        />
        {#if modelSearch}
          <button
            class="clear-btn absolute right-2.5 top-1/2 -translate-y-1/2 p-1"
            onclick={() => (modelSearch = '')}
          >
            <X class="h-3.5 w-3.5" />
          </button>
        {/if}
      </div>
      {#if isElectron()}
        <Tooltip label="Cloud models" position="bottom">
          <button
            type="button"
            class="mode-icon-btn shrink-0"
            class:is-active={appStore.backendMode === 'api'}
            onclick={(e) => {
              e.stopPropagation();
              void appStore.setBackendMode('api').then(() => initCloudListWhenOpen());
            }}
            aria-label="Cloud models"
            aria-pressed={appStore.backendMode === 'api'}
          >
            <Cloud class="h-4 w-4" />
          </button>
        </Tooltip>
        <Tooltip label="On-device models" position="bottom">
          <button
            type="button"
            class="mode-icon-btn shrink-0"
            class:is-active={appStore.backendMode === 'local'}
            onclick={(e) => {
              e.stopPropagation();
              void appStore.setBackendMode('local');
            }}
            aria-label="On-device models"
            aria-pressed={appStore.backendMode === 'local'}
          >
            <Cpu class="h-4 w-4" />
          </button>
        </Tooltip>
      {/if}

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
          >
            <RefreshCw class="h-4 w-4" />
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
    <div class="model-list max-h-72 overflow-y-auto px-2 pb-2.5">
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
                  class="provider-row flex w-full items-center gap-2 rounded-full px-2.5 py-1.5 text-left transition hover:bg-muted/60"
                  style="-webkit-app-region: no-drag; pointer-events: auto;"
                  onclick={(e) => {
                    e.stopPropagation();
                    toggleProvider(prov.id);
                  }}
                >
                  <ChevronDown
                    class="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150 {open
                      ? 'rotate-0'
                      : '-rotate-90'}"
                  />
                  <span class="min-w-0 flex-1">
                    <span class="flex items-center gap-1.5">
                      <span class="text-[13px] font-medium text-foreground">{prov.label}</span>
                      {#if prov.isActive}
                        <span class="text-[12px] text-muted-foreground">active</span>
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
                          style="-webkit-app-region: no-drag; pointer-events: auto;"
                          onclick={(e) => {
                            e.stopPropagation();
                            void selectCloudModel(prov.id, model.id);
                          }}
                        >
                          {#if selected}
                            <Check class="h-3.5 w-3.5 shrink-0 text-fg-secondary" />
                          {:else}
                            <span class="inline-block w-3.5 shrink-0"></span>
                          {/if}
                          <span class="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground"
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

  :global(.dark) .mode-info svg {
    filter: invert(1);
  }

  @keyframes modelDotPulse {
    0%, 100% { transform: scale(1); opacity: 0.8; }
    50% { transform: scale(1.25); opacity: 1; }
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
    width: min(430px, calc(100vw - 32px));
    max-height: min(600px, calc(100vh - 64px));
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
    border-radius: var(--radius-full);
    transition: background-color var(--motion-fast) var(--motion-ease);
  }

  .model-row.is-selected {
    background: var(--surface-active);
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

  :global(.dark) .live-badge {
    color: var(--live-indicator-dark);
    background: var(--success-bg);
  }
</style>

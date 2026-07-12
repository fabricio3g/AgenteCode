<svelte:options runes={true} />

<script lang="ts">
  import { Check, ChevronDown, Cloud, Cpu, LoaderCircle, Play, Power, RefreshCw, Search, Sparkles, Square, X } from 'lucide-svelte';
  import { motionFade } from '$lib/utils/transitions';
  import { appStore } from '$lib/stores/app.svelte';
  import { modelsStore } from '$lib/stores/models.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { isTauri } from '$lib/services/tauri';
  import type { ModelOption } from '$lib/types/chat';
  import { buildLocalModelSecondaryText, formatContextLength, localModelMatchesSearch } from '$lib/utils/local-models';

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
  let unloading = $state(false);
  let confirmSwitch = $state<ModelOption | null>(null);
  let dropdownPos = $state({ top: 0, left: 0, width: 320 });

  const activeProvider = $derived(appStore.activeProvider);
  const displayLabel = $derived(appStore.activeModelLabel);
  const localLoading = $derived(appStore.localModelLoading);

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

  $effect(() => {
    if (!appStore.modelMenuOpen) {
      modelSearch = '';
      confirmSwitch = null;
      return;
    }
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (!triggerEl?.contains(target) && !dropdownEl?.contains(target)) {
        appStore.modelMenuOpen = false;
      }
    }
    function handleResize() {
      updateDropdownPos();
    }
    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('resize', handleResize);
    setTimeout(() => searchInput?.focus(), 50);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('resize', handleResize);
    };
  });
</script>

<!-- Trigger: compact model selector -->
<button
  bind:this={triggerEl}
  class="model-trigger flex h-8 max-w-[18rem] items-center gap-1.5 px-2.5 transition"
  class:is-open={appStore.modelMenuOpen}
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

<!-- Dropdown: fixed position to escape navbar stacking context -->
{#if appStore.modelMenuOpen}
  <div
    bind:this={dropdownEl}
    class="model-dropdown fixed overflow-hidden"
    style="top:{dropdownPos.top}px; left:{dropdownPos.left}px; width:{dropdownPos.width}px; z-index:200;"
    transition:motionFade={{ duration: 100 }}
  >
    <!-- Header -->
    <div class="flex items-center justify-between px-3 pt-2.5 pb-2">
      <span class="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">
        {appStore.backendMode === 'local' ? 'On Device Models' : 'Cloud Models'}
      </span>
      {#if appStore.backendMode === 'api'}
        <button
          class="refresh-btn p-1.5"
          onclick={() => { appStore.refreshModels(true); modelsStore.refreshStatus(); }}
          aria-label="Refresh"
        >
          <RefreshCw class="h-3.5 w-3.5" />
        </button>
      {/if}
    </div>

    <!-- Cloud / On Device mode toggle -->
    {#if isTauri()}
      <div class="aui-segmented mx-3 mb-2.5 w-[calc(100%-1.5rem)]">
        <button
          type="button"
          class={`aui-segmented-item flex-1 py-1.5 ${appStore.backendMode === 'api' ? 'is-active' : ''}`}
          onclick={() => appStore.setBackendMode('api')}
        >Cloud</button>
        <button
          type="button"
          class={`aui-segmented-item flex-1 py-1.5 ${appStore.backendMode === 'local' ? 'is-active' : ''}`}
          onclick={() => appStore.setBackendMode('local')}
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

    <!-- Search -->
    {#if appStore.models.length > 5}
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
    <div class="model-list max-h-64 overflow-y-auto px-2 pb-2.5">
      {#if !appStore.models.length}
        <div class="empty-state flex flex-col items-center gap-3 px-4 py-6 text-center">
          <div class="empty-icon flex h-10 w-10 items-center justify-center">
            <Sparkles class="h-5 w-5 text-[var(--text-muted)]" />
          </div>
          <div>
            <p class="text-sm font-medium text-[var(--text-secondary)]">
              {appStore.backendMode === 'local' ? 'No local models' : 'No models available'}
            </p>
            <p class="mt-0.5 text-xs text-[var(--text-muted)]">
              {appStore.backendMode === 'local' ? 'Download models from Models' : 'Configure a provider in Settings'}
            </p>
          </div>
          <button
            class="empty-btn inline-flex items-center gap-2 px-4 py-2 text-sm font-medium"
            onclick={() => {
              appStore.modelMenuOpen = false;
              if (appStore.backendMode === 'api') {
                appStore.modelManagerOpenSection = 'providers';
              }
              appStore.modelManagerOpen = true;
            }}
          >
            {appStore.backendMode === 'local' ? 'Open Models' : 'Configure Provider'}
          </button>
        </div>
      {:else if filteredModels.length === 0}
        <div class="px-4 py-6 text-center">
          <p class="text-sm text-[var(--text-muted)]">No models match your search</p>
        </div>
      {:else}
        <div class="space-y-0.5">
          {#each filteredModels as model (model.id)}
            {@const loaded = appStore.backendMode === 'local' && isLoaded(model)}
            {@const loadingTarget = appStore.backendMode === 'local' && isLoadingModel(model)}

            <div
              class="model-item group flex w-full items-center gap-2 px-2 py-1.5 transition {loaded ? 'is-loaded' : ''}"
            >
              <!-- Model name + details -->
              <div
                class="min-w-0 flex-1 cursor-pointer"
                role="button"
                tabindex="0"
                onclick={async () => {
                  if (appStore.backendMode === 'local') return;
                  await appStore.updateProvider({
                    provider: appStore.activeProviderName,
                    base_url: activeProvider?.base_url || 'https://api.openai.com/v1',
                    api_key: activeProvider?.api_key,
                    model: model.id
                  });
                  appStore.modelMenuOpen = false;
                }}
                onkeydown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLElement).click(); }}
              >
                <div class="flex items-center gap-1.5">
                  {#if appStore.backendMode === 'api' && activeProvider?.model === model.id}
                    <Check class="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
                  {/if}
                  <span class="text-[12px] font-medium text-[var(--text)] truncate">{model.name}</span>
                </div>
                {#if appStore.backendMode === 'local'}
                  {#if metaLine(model)}
                    <div class="mt-0.5 truncate text-[11px] text-[var(--text-muted)]">{metaLine(model)}</div>
                  {/if}
                {:else if model.details}
                  <div class="mt-0.5 truncate text-[11px] text-[var(--text-muted)]">{model.details}</div>
                {/if}
              </div>

              <!-- Load / Unload button (local only) -->
              {#if appStore.backendMode === 'local' && model.path}
                {#if loaded}
                  <button
                    type="button"
                    class="action-btn unload shrink-0 inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium disabled:opacity-50"
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
                    class="action-btn load shrink-0 inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium disabled:opacity-40"
                    onclick={async (e) => { e.stopPropagation(); await handleLoad(model); }}
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
    <div class="dropdown-footer border-t border-[var(--border)] px-3 py-2 space-y-1.5">
      <button
        class="refresh-footer-btn flex w-full items-center justify-center gap-2 px-3 py-1.5 text-[12px] font-medium"
        onclick={() => { appStore.refreshModels(true); modelsStore.refreshStatus(); if (isTauri()) modelsStore.refreshIndex(); }}
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
      {#if appStore.backendMode === 'local'}
        <button
          class="hub-btn flex w-full items-center justify-center gap-2 px-3 py-1.5 text-[12px] font-medium"
          onclick={() => { appStore.modelMenuOpen = false; appStore.modelManagerOpen = true; }}
        >Browse Models</button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .model-trigger {
    color: var(--muted-foreground);
    background: transparent;
    border: none;
    border-radius: var(--radius-md);
    box-shadow: none;
  }

  .model-trigger:hover,
  .model-trigger.is-open {
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

  .model-dropdown {
    background: var(--popover);
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    box-shadow: var(--shadow-lg);
  }

  .refresh-btn {
    color: var(--muted-foreground);
    background: transparent;
    border: none;
    border-radius: var(--radius-md);
  }

  .refresh-btn:hover {
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
    border-radius: var(--radius-md);
  }

  .confirm-btn.primary {
    background: var(--primary);
    color: var(--primary-foreground);
    border: none;
    border-radius: var(--radius-md);
  }

  .confirm-btn.primary:hover {
    opacity: 0.9;
  }

  .confirm-btn.secondary {
    background: transparent;
    color: var(--muted-foreground);
    border: none;
    border-radius: var(--radius-md);
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
    border-radius: 8px;
    transition: opacity 0.12s;
  }

  .empty-btn:hover {
    opacity: 0.88;
  }

  .model-item {
    background: transparent;
    border: none;
    border-radius: var(--radius-md);
  }

  .model-item:hover,
  .model-item.is-loaded {
    background: var(--muted);
  }

  :global(.dark) .live-badge {
    color: var(--live-indicator-dark);
    background: var(--success-bg);
  }

  .action-btn {
    background: transparent;
    color: var(--muted-foreground);
    border: none;
    border-radius: var(--radius-md);
  }

  .action-btn:hover {
    color: var(--foreground);
    background: var(--muted);
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

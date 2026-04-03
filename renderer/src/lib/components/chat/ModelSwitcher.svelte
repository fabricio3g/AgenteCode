<svelte:options runes={true} />

<script lang="ts">
  import { Check, ChevronDown, LoaderCircle, Play, Power, RefreshCw, Search, Sparkles, Square, X } from 'lucide-svelte';
  import { fade } from 'svelte/transition';
  import { appStore } from '$lib/stores/app.svelte';
  import { modelsStore } from '$lib/stores/models.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { isTauri } from '$lib/services/tauri';

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
  let confirmSwitch = $state<{ id: string; name: string; path?: string; details?: string } | null>(null);
  let dropdownPos = $state({ top: 0, left: 0, width: 320 });

  const activeProvider = $derived(appStore.activeProvider);
  const displayLabel = $derived(appStore.activeModelLabel);
  const localLoading = $derived(appStore.localModelLoading);

  const filteredModels = $derived(
    modelSearch.trim()
      ? appStore.models.filter((m) =>
          m.name.toLowerCase().includes(modelSearch.toLowerCase()) ||
          m.id.toLowerCase().includes(modelSearch.toLowerCase())
        )
      : appStore.models
  );

  function isLoaded(model: { id: string; name: string; path?: string }) {
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

  async function handleLoad(model: { id: string; name: string; path?: string; details?: string }) {
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

<!-- Trigger: clean flat text button -->
<button
  bind:this={triggerEl}
  class="model-trigger flex max-w-[18rem] items-center gap-1.5 rounded-lg px-2 py-1 transition"
  onclick={toggleMenu}
>
    {#if appStore.backendMode === 'local'}
      {#if isAnyModelLoaded}
        <span class="relative flex h-1.5 w-1.5 shrink-0">
          <span class="status-ping absolute inline-flex h-full w-full animate-ping rounded-full opacity-75"></span>
          <span class="status-dot relative inline-flex h-1.5 w-1.5 rounded-full"></span>
        </span>
      {:else if localLoading}
        <LoaderCircle class="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--text-muted)]" />
      {/if}
    <span class="truncate text-[13px] text-[var(--text-secondary)]">
      {isAnyModelLoaded ? loadedModelFilename : localLoading ? 'Loading...' : 'No model'}
    </span>
  {:else}
    <span class="truncate text-[13px] text-[var(--text-secondary)]">{displayLabel || 'No model'}</span>
  {/if}
  <ChevronDown class="h-3 w-3 shrink-0 text-[var(--text-muted)] transition-transform duration-150 {appStore.modelMenuOpen ? 'rotate-180' : ''}" />
</button>

<!-- Dropdown: fixed position to escape navbar stacking context -->
{#if appStore.modelMenuOpen}
  <div
    bind:this={dropdownEl}
    class="model-dropdown fixed overflow-hidden"
    style="top:{dropdownPos.top}px; left:{dropdownPos.left}px; width:{dropdownPos.width}px; z-index:200;"
    transition:fade={{ duration: 100 }}
  >
    <!-- Header -->
    <div class="flex items-center justify-between px-4 pt-3 pb-2">
      <span class="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
        {appStore.backendMode === 'local' ? 'Local Models' : 'Models'}
      </span>
      <button
        class="refresh-btn rounded-lg p-1.5"
        onclick={() => { appStore.refreshModels(); modelsStore.refresh(); }}
        aria-label="Refresh"
      >
        <RefreshCw class="h-3.5 w-3.5" />
      </button>
    </div>

    <!-- API / Local mode toggle -->
    {#if isTauri()}
      <div class="mode-toggle mx-4 mb-3 flex gap-1 rounded-xl p-0.5">
        <button
          class={`mode-btn flex-1 rounded-lg py-1.5 text-[13px] font-medium transition ${appStore.backendMode === 'api' ? 'is-active' : ''}`}
          onclick={() => appStore.setBackendMode('api')}
        >API</button>
        <button
          class={`mode-btn flex-1 rounded-lg py-1.5 text-[13px] font-medium transition ${appStore.backendMode === 'local' ? 'is-active' : ''}`}
          onclick={() => appStore.setBackendMode('local')}
        >Local</button>
      </div>
    {/if}

    <!-- Runtime busy -->
    {#if appStore.backendMode === 'local' && localLoading}
      <div class="loading-indicator mx-4 mb-3 flex items-center gap-2.5 rounded-xl px-3 py-2.5">
        <LoaderCircle class="h-4 w-4 shrink-0 animate-spin text-[var(--text-muted)]" />
        <span class="text-sm font-medium text-[var(--text-secondary)]">Loading model...</span>
      </div>
    {/if}

    <!-- Switch confirmation -->
    {#if confirmSwitch}
      <div class="confirm-card mx-4 mb-3 rounded-xl p-3">
        <p class="text-sm text-[var(--text-secondary)]">
          Unload <span class="font-semibold text-[var(--text)]">{loadedModelFilename}</span> and load <span class="font-semibold text-[var(--text)]">{confirmSwitch.name}</span>?
        </p>
        <div class="mt-3 flex gap-2">
          <button
            class="confirm-btn primary flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold"
            onclick={confirmSwitchModel}
          >
            <Power class="h-3.5 w-3.5" />
            Switch
          </button>
          <button
            class="confirm-btn secondary rounded-lg px-3 py-1.5 text-sm font-medium"
            onclick={() => (confirmSwitch = null)}
          >Cancel</button>
        </div>
      </div>
    {/if}

    <!-- Search -->
    {#if appStore.models.length > 5}
      <div class="search-wrapper relative mx-4 mb-3">
        <Search class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
        <input
          bind:this={searchInput}
          bind:value={modelSearch}
          type="text"
          placeholder="Search models..."
          class="search-input w-full rounded-xl py-2 pl-10 pr-10 text-sm text-[var(--text)] outline-none transition placeholder:text-[var(--text-muted)]"
          onclick={(e) => e.stopPropagation()}
          onkeydown={(e) => e.key === 'Escape' && (appStore.modelMenuOpen = false)}
        />
        {#if modelSearch}
          <button
            class="clear-btn absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1"
            onclick={() => (modelSearch = '')}
          >
            <X class="h-3.5 w-3.5" />
          </button>
        {/if}
      </div>
    {/if}

    <!-- Model list -->
    <div class="model-list max-h-64 overflow-y-auto px-3 pb-3">
      {#if !appStore.models.length}
        <div class="empty-state flex flex-col items-center gap-3 px-4 py-6 text-center">
          <div class="empty-icon flex h-10 w-10 items-center justify-center rounded-xl">
            <Sparkles class="h-5 w-5 text-[var(--text-muted)]" />
          </div>
          <div>
            <p class="text-sm font-medium text-[var(--text-secondary)]">
              {appStore.backendMode === 'local' ? 'No local models' : 'No models available'}
            </p>
            <p class="mt-0.5 text-xs text-[var(--text-muted)]">
              {appStore.backendMode === 'local' ? 'Download models from the hub' : 'Configure a provider in settings'}
            </p>
          </div>
          <button
            class="empty-btn inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium"
            onclick={() => {
              appStore.modelMenuOpen = false;
              if (appStore.backendMode === 'api') {
                appStore.modelManagerOpenSection = 'providers';
              }
              appStore.modelManagerOpen = true;
            }}
          >
            {appStore.backendMode === 'local' ? 'Open Model Hub' : 'Configure Provider'}
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

            <div
              class="model-item group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 transition {loaded ? 'is-loaded' : ''}"
            >
              <!-- Status indicator -->
              <div class="flex h-5 w-5 shrink-0 items-center justify-center">
                {#if appStore.backendMode === 'local'}
                  {#if loaded}
                    <span class="relative flex h-2 w-2">
                      <span class="status-ping absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"></span>
                      <span class="status-dot relative inline-flex h-2 w-2 rounded-full"></span>
                    </span>
                  {:else}
                    <span class="h-1.5 w-1.5 rounded-full bg-[var(--border-strong)]"></span>
                  {/if}
                {:else}
                  {#if activeProvider?.model === model.id}
                    <Check class="h-3.5 w-3.5 text-[var(--text-secondary)]" />
                  {:else}
                    <span class="h-1.5 w-1.5 rounded-full bg-[var(--border)]"></span>
                  {/if}
                {/if}
              </div>

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
                  <span class="text-sm font-medium text-[var(--text)] truncate">{model.name}</span>
                  {#if loaded}
                    <span class="live-badge shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide">Live</span>
                  {/if}
                </div>
                {#if model.details}
                  <div class="mt-0.5 truncate text-xs text-[var(--text-muted)]">{model.details}</div>
                {/if}
              </div>

              <!-- Load / Unload button (local only) -->
              {#if appStore.backendMode === 'local' && model.path}
                {#if loaded}
                  <button
                    type="button"
                    class="action-btn unload shrink-0 inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium disabled:opacity-50"
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
                    class="action-btn load shrink-0 inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium disabled:opacity-40"
                    onclick={async (e) => { e.stopPropagation(); await handleLoad(model); }}
                    disabled={localLoading}
                  >
                    {#if localLoading}
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
    {#if appStore.backendMode === 'local'}
      <div class="dropdown-footer border-t border-[var(--border)] px-4 py-2.5">
        <button
          class="hub-btn flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-medium"
          onclick={() => { appStore.modelMenuOpen = false; appStore.modelManagerOpen = true; }}
        >Browse Model Hub</button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .model-trigger {
    background: transparent;
  }

  .model-trigger:hover {
    background: var(--surface-highlight);
  }

  .model-dropdown {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    box-shadow: var(--shadow-l);
  }

  .refresh-btn {
    color: var(--text-muted);
    background: transparent;
    transition: color 0.12s, background 0.12s;
  }

  .refresh-btn:hover {
    color: var(--text);
    background: var(--surface-highlight);
  }

  .mode-toggle {
    background: var(--surface-highlight);
  }

  .mode-btn {
    color: var(--text-tertiary);
  }

  .mode-btn:hover {
    color: var(--text-secondary);
  }

  .mode-btn.is-active {
    color: var(--text);
    background: var(--surface);
    box-shadow: var(--shadow-s);
  }

  .loading-indicator {
    background: var(--surface-highlight);
  }

  .confirm-card {
    background: var(--surface-highlight);
    border: 1px solid var(--border);
  }

  .confirm-btn.primary {
    background: var(--primary);
    color: var(--primary-fg);
  }

  .confirm-btn.primary:hover {
    opacity: 0.9;
  }

  .confirm-btn.secondary {
    background: var(--surface);
    color: var(--text-secondary);
    border: 1px solid var(--border);
  }

  .confirm-btn.secondary:hover {
    background: var(--surface-highlight);
    border-color: var(--border-strong);
  }

  .search-wrapper .search-input {
    background: var(--surface-highlight);
    border: 1px solid var(--border);
  }

  .search-wrapper .search-input:focus {
    border-color: var(--border-strong);
  }

  .clear-btn {
    color: var(--text-muted);
  }

  .clear-btn:hover {
    color: var(--text);
  }

  .empty-icon {
    background: var(--surface-highlight);
  }

  .empty-btn {
    background: var(--primary);
    color: var(--primary-fg);
  }

  .empty-btn:hover {
    opacity: 0.9;
  }

  .model-item {
    background: transparent;
  }

  .model-item:hover {
    background: var(--surface-highlight);
  }

  .model-item.is-loaded {
    background: var(--surface-highlight);
  }

  .live-badge {
    color: var(--live-indicator);
    background: var(--success-bg);
  }

  :global(.dark) .live-badge {
    color: var(--live-indicator-dark);
    background: var(--success-bg);
  }

  .action-btn {
    background: var(--surface);
    color: var(--text-secondary);
    border: 1px solid var(--border);
    transition: all 0.12s;
  }

  .action-btn:hover {
    background: var(--surface-highlight);
    border-color: var(--border-strong);
  }

  .action-btn.unload:hover {
    background: var(--error-bg);
    border-color: var(--error-border);
    color: var(--error);
  }

  .action-btn.load:hover {
    background: var(--primary);
    border-color: var(--primary);
    color: var(--primary-fg);
  }

  .hub-btn {
    background: var(--surface-highlight);
    color: var(--text-secondary);
    transition: all 0.12s;
  }

  .hub-btn:hover {
    background: var(--primary);
    color: var(--primary-fg);
  }

  :global(.dark) .status-ping {
    background: var(--live-indicator-dark);
  }
  .status-dot {
    background: var(--live-indicator);
  }
  :global(.dark) .status-dot {
    background: var(--live-indicator-dark);
  }
</style>

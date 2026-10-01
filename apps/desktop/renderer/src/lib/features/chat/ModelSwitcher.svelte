<svelte:options runes={true} />

<script lang="ts">
  import { untrack } from 'svelte';
  import { get } from 'svelte/store';
  import { Check, ChevronDown, ChevronRight, Cpu, LoaderCircle, Play, Power, RefreshCw, Search, Settings2, Square, X } from 'lucide-svelte';
  import { backdropIn, backdropOut, dialogIn, dialogOut, motionSlide } from '$lib/utils/transitions';
  import { appStore } from '$lib/stores/app.svelte';
  import { modelsStore } from '$lib/stores/models.svelte';
  import { providerModels } from '$lib/stores/provider-models.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { isElectron } from '$lib/services/bridge';
  import { modalLayer } from '$lib/components/ui/modal-layer';
  import { t } from 'svelte-i18n';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import ProviderIcon from '$lib/components/ui/ProviderIcon.svelte';
  import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
  import type { ModelOption } from '$lib/types/chat';
  import { buildLocalModelSecondaryText, formatContextLength, localModelMatchesSearch } from '$lib/utils/local-models';
  import { configuredProviders, defaultBaseUrl, providerLabel } from '$lib/utils/providers';

  let { compact = false }: { compact?: boolean } = $props();

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
  let expandedProviders = $state<Record<string, boolean>>({});
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

  function modelsForProvider(id: string): ModelOption[] {
    const list = providerModels.models(id);
    const q = modelSearch.trim().toLowerCase();
    const matchesProvider = providerLabel(id).toLowerCase().includes(q);
    const matches = !q || matchesProvider ? list : list.filter((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
    return matches.slice().sort((a, b) => {
      const selected = id === appStore.activeProviderName ? activeProvider?.model : '';
      return Number(b.id === selected) - Number(a.id === selected) || a.name.localeCompare(b.name);
    });
  }

  const visibleProviders = $derived(configured.filter((provider) => !modelSearch.trim() || modelsForProvider(provider.id).length || providerModels.loading[provider.id] || providerModels.errors[provider.id]));
  const resultCount = $derived(appStore.backendMode === 'api' ? visibleProviders.reduce((sum, provider) => sum + modelsForProvider(provider.id).length, 0) : filteredModels.length);

  function isProviderExpanded(id: string): boolean {
    if (modelSearch.trim()) {
      return modelsForProvider(id).length > 0 || expandedProviders[id] === true;
    }
    // Groups start collapsed (the header shows the model in use); a click opens one.
    return expandedProviders[id] === true;
  }

  function toggleProvider(id: string) {
    const nextOpen = !isProviderExpanded(id);
    expandedProviders = { ...expandedProviders, [id]: nextOpen };
    if (nextOpen) void providerModels.load(id);
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
      toastStore.error(get(t)('modelPicker.switchFailed'));
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
      toastStore.error(get(t)('modelPicker.sourceFailed'));
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
      toastStore.success(get(t)('modelPicker.unloaded'));
    } catch {
      toastStore.error(get(t)('modelPicker.unloadFailed'));
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

  /** Cloud refreshes the provider in use; On device rescans the model folders. */
  const refreshing = $derived(appStore.backendMode === 'api' ? !!providerModels.loading[appStore.activeProviderName] : appStore.modelsRefreshing);

  function refresh() {
    appStore.refreshModels(true);
    modelsStore.refreshStatus();
    if (appStore.backendMode === 'api') {
      const active = appStore.activeProviderName;
      if (active) void providerModels.load(active, true);
    } else if (isElectron()) {
      modelsStore.refreshIndex();
    }
  }

  function openManager(section: 'providers' | 'explore') {
    appStore.modelMenuOpen = false;
    appStore.modelManagerOpenSection = section;
    appStore.modelManagerOpen = true;
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
      // Every opening starts collapsed; the list is fetched ahead for search.
      expandedProviders = {};
      void providerModels.load(active);
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

    // Escape, focus trapping and focus return come from modalLayer; this only
    // adds arrow-key movement between the search field and the model rows.
    function handleKeydown(event: KeyboardEvent) {
      if (!panelEl) return;
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
    };
  });

  // Search all configured providers, including groups that haven't been opened.
  $effect(() => {
    if (!appStore.modelMenuOpen || appStore.backendMode !== 'api' || !modelSearch.trim()) return;
    const timer = setTimeout(() => untrack(() => {
      for (const provider of configured) void providerModels.load(provider.id);
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
  class:is-compact={compact}
  style="-webkit-app-region: no-drag; pointer-events: auto;"
  onclick={toggleMenu}
  aria-haspopup="dialog"
  aria-expanded={appStore.modelMenuOpen}
  aria-controls={dialogId}
  aria-label={$t('modelPicker.triggerLabel', { values: { model: displayLabel || $t('modelPicker.onDevice') } })}
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
      {$t('modelPicker.onDevice')}
    {:else}
      {displayLabel || $t('modelPicker.selectModel')}
    {/if}
  </span>
  <ChevronDown class="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150 {appStore.modelMenuOpen ? 'rotate-180' : ''}" />
</button>

<!-- Modal: portaled to body so Electron titlebar drag region cannot swallow clicks.
     Gray backdrop fills the window; square panel sits centered with fade/scale. -->
{#if appStore.modelMenuOpen}
  <div use:portalToBody use:modalLayer={{ onclose: () => (appStore.modelMenuOpen = false) }} class="model-modal-root fixed inset-0">
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="model-modal-backdrop absolute inset-0" onclick={() => (appStore.modelMenuOpen = false)} in:backdropIn out:backdropOut></div>
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
        in:dialogIn
        out:dialogOut
      >
        <h2 id={`${dialogId}-title`} class="sr-only">{$t('modelPicker.title')}</h2>

        <!-- One slim bar: where models come from, refresh, providers, close. -->
        <div class="picker-bar">
          {#if isElectron()}
            <SegmentedControl value={appStore.backendMode} options={[{ value: 'api', label: $t('modelPicker.cloud'), disabled: changingMode || !!selectingModel }, { value: 'local', label: $t('modelPicker.onDevice'), disabled: changingMode || !!selectingModel }]} label={$t('modelPicker.source')} onchange={(mode) => void changeBackend(mode)} />
          {:else}
            <span class="picker-title">{$t('modelPicker.title')}</span>
          {/if}
          <span class="flex-1"></span>
          <Tooltip label={$t('modelPicker.refresh')} position="bottom">
            <button type="button" class="ui-icon-button is-sm" onclick={refresh} aria-label={$t('modelPicker.refresh')} disabled={refreshing}>
              <RefreshCw class={refreshing ? 'animate-spin' : ''} />
            </button>
          </Tooltip>
          {#if appStore.backendMode === 'api'}
            <Tooltip label={$t('modelPicker.manageProviders')} position="bottom">
              <button type="button" class="ui-icon-button is-sm" onclick={() => openManager('providers')} aria-label={$t('modelPicker.manageProviders')}>
                <Settings2 />
              </button>
            </Tooltip>
          {/if}
          <button type="button" class="ui-icon-button is-sm" onclick={() => (appStore.modelMenuOpen = false)} aria-label={$t('modelPicker.close')}><X /></button>
        </div>

        <label class="ui-pill-field picker-search">
          <Search class="size-3.5 shrink-0 text-muted-foreground" />
          <input
            bind:this={searchInput}
            bind:value={modelSearch}
            type="search"
            aria-label={$t('modelPicker.search')}
            placeholder={$t('modelPicker.searchPlaceholder')}
            onclick={(e) => e.stopPropagation()}
          />
          {#if modelSearch}
            <button type="button" class="ui-icon-button is-xs -mr-1.5" aria-label={$t('modelPicker.clearSearch')} onclick={() => (modelSearch = '')}><X /></button>
          {/if}
        </label>

        {#if appStore.backendMode === 'local' && localLoading}
          <div class="picker-note" role="status">
            <LoaderCircle class="size-3.5 shrink-0 animate-spin" />
            <span>{$t('modelPicker.loadingModel')}</span>
          </div>
        {/if}

        {#if confirmSwitch}
          <div class="picker-note">
            <span class="min-w-0 flex-1">{$t('modelPicker.switchConfirm', { values: { current: loadedModelFilename, next: confirmSwitch.name } })}</span>
            <button type="button" class="ui-chip" onclick={() => (confirmSwitch = null)}>{$t('modelPicker.cancel')}</button>
            <button type="button" class="ui-chip is-primary" onclick={confirmSwitchModel}><Power /> {$t('modelPicker.switch')}</button>
          </div>
        {/if}

        {#snippet empty(title: string, hint: string, action: string, onaction: () => void)}
          <div class="picker-empty">
            <p>{title}</p>
            <span>{hint}</span>
            <button type="button" class="ui-chip" onclick={onaction}>{action}</button>
          </div>
        {/snippet}

        <div class="model-list" aria-label={$t('modelPicker.available')} aria-busy={changingMode}>
          {#if appStore.backendMode === 'api'}
            {#if !configured.length}
              {@render empty($t('modelPicker.noProviders'), $t('modelPicker.noProvidersHint'), $t('modelPicker.configureProvider'), () => openManager('providers'))}
            {:else if !visibleProviders.length}
              {@render empty($t('modelPicker.noResults'), $t('modelPicker.noResultsHint'), $t('modelPicker.clearSearch'), () => (modelSearch = ''))}
            {:else}
              {#each visibleProviders as prov (prov.id)}
                {@const open = isProviderExpanded(prov.id)}
                {@const list = modelsForProvider(prov.id)}
                {@const loading = !!providerModels.loading[prov.id]}
                <div class="provider-group">
                  <button
                    type="button"
                    class="group-head"
                    onclick={(e) => {
                      e.stopPropagation();
                      toggleProvider(prov.id);
                    }}
                    aria-expanded={open}
                  >
                    <ProviderIcon provider={prov.id} size={14} />
                    <span class="group-name">{prov.label}</span>
                    {#if prov.isActive}<span class="group-meta">· {$t('modelPicker.connected')}</span>{/if}
                    <span class="flex-1"></span>
                    {#if loading}<LoaderCircle class="size-3 shrink-0 animate-spin" />{/if}
                    {#if prov.model && !open}<span class="group-current">{prov.model}</span>{/if}
                    <ChevronRight class="group-chevron size-3.5 shrink-0 {open ? 'rotate-90' : ''}" />
                  </button>

                  {#if open}
                    <div class="group-models" transition:motionSlide={{ duration: 200 }}>
                      {#if providerModels.errors[prov.id]}
                        <div class="picker-note is-inline" role="status">
                          <span class="min-w-0 flex-1">{providerModels.errors[prov.id]}</span>
                          <button type="button" class="ui-chip" disabled={loading} onclick={() => void providerModels.load(prov.id, true)}>{$t('modelPicker.retry')}</button>
                        </div>
                      {/if}
                      {#if list.length === 0}
                        <p class="group-hint">{loading ? $t('modelPicker.loading') : modelSearch ? $t('modelPicker.noMatches') : $t('modelPicker.noProviderModels')}</p>
                      {:else}
                        {#each list as model (model.id)}
                          {@const selected = appStore.activeProviderName === prov.id && activeProvider?.model === model.id}
                          <button
                            type="button"
                            class="model-row"
                            class:is-selected={selected}
                            data-model-option
                            aria-pressed={selected}
                            disabled={!!selectingModel || changingMode}
                            onclick={(e) => {
                              e.stopPropagation();
                              void selectCloudModel(prov.id, model.id);
                            }}
                          >
                            <span class="row-mark">
                              {#if selectingModel === `${prov.id}/${model.id}`}<LoaderCircle class="size-3.5 animate-spin" />
                              {:else if selected}<Check class="size-3.5" />{/if}
                            </span>
                            <span class="min-w-0 flex-1 truncate">{model.name}</span>
                            {#if model.id !== model.name}<span class="row-id">{model.id}</span>{/if}
                            {#if selected}<span class="row-tag">{$t('modelPicker.inUse')}</span>{/if}
                          </button>
                        {/each}
                      {/if}
                    </div>
                  {/if}
                </div>
              {/each}
            {/if}
          {:else if !appStore.models.length}
            {@render empty($t('modelPicker.noLocal'), $t('modelPicker.noLocalHint'), $t('modelPicker.explore'), () => openManager('explore'))}
          {:else if filteredModels.length === 0}
            {@render empty($t('modelPicker.noResults'), $t('modelPicker.noResultsHint'), $t('modelPicker.clearSearch'), () => (modelSearch = ''))}
          {:else}
            {#each filteredModels as model (model.id)}
              {@const loaded = isLoaded(model)}
              {@const loadingTarget = isLoadingModel(model)}
              <div class="model-row is-local" class:is-selected={loaded}>
                <span class="row-mark">{#if loaded}<Check class="size-3.5" />{/if}</span>
                <span class="min-w-0 flex-1 truncate">{model.name}</span>
                {#if metaLine(model)}<span class="row-id">{metaLine(model)}</span>{/if}
                {#if model.path}
                  {#if loaded}
                    <button type="button" class="ui-chip text-error" onclick={handleUnload} disabled={unloading}>
                      {#if unloading}<LoaderCircle class="animate-spin" />{:else}<Square />{/if}
                      {$t('modelPicker.unload')}
                    </button>
                  {:else}
                    <button
                      type="button"
                      class="ui-chip"
                      onclick={async (e) => {
                        e.stopPropagation();
                        await handleLoad(model);
                      }}
                      disabled={localLoading}
                      data-model-option
                    >
                      {#if loadingTarget}<LoaderCircle class="animate-spin" /> {$t('modelPicker.loading')}{:else}<Play /> {$t('modelPicker.load')}{/if}
                    </button>
                  {/if}
                {/if}
              </div>
            {/each}
          {/if}
        </div>

        <footer class="picker-footer">
          <span aria-live="polite">{$t(modelSearch ? 'modelPicker.countFound' : 'modelPicker.countAvailable', { values: { n: resultCount } })}</span>
          <span class="picker-key-hint"><kbd>↑</kbd><kbd>↓</kbd> {$t('modelPicker.navigate')} <kbd>esc</kbd> {$t('modelPicker.close')}</span>
        </footer>
      </div>
    </div>
  </div>
{/if}

<style>
  /* Borderless, like the add button beside it: a soft fill only on hover. */
  .model-trigger {
    color: var(--text-secondary);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-full);
    box-shadow: none;
    transition:
      background-color var(--motion-fast) var(--motion-ease),
      border-color var(--motion-fast) var(--motion-ease),
      color var(--motion-fast) var(--motion-ease);
  }

  .model-trigger:hover,
  .model-trigger.is-open {
    background: var(--muted);
    color: var(--foreground);
  }

  .model-trigger.is-compact {
    min-width: 0;
    max-width: 100%;
    width: 100%;
    justify-content: flex-start;
    padding-inline: 0.375rem;
  }

  .model-trigger.is-compact .trigger-label { min-width: 0; }

  .trigger-label {
    color: inherit;
    font-size: 0.8125rem;
    font-weight: 500;
    letter-spacing: -0.01em;
  }

  /* Centered over the backdrop, wide enough for long model ids; its height
     follows the list up to the window. */
  .model-modal-root {
    -webkit-app-region: no-drag;
  }

  .model-modal-backdrop {
    background: var(--overlay);
    backdrop-filter: blur(4px);
  }

  .model-modal {
    width: min(760px, calc(100vw - 32px));
    max-height: min(680px, calc(100dvh - 48px));
    background: var(--card);
    border-radius: var(--radius-2xl);
    box-shadow:
      inset 0 0 0 1px var(--composer-ring),
      var(--shadow-xl);
    -webkit-app-region: no-drag;
    transform-origin: 50% 40%;
    will-change: transform, opacity, filter;
  }

  .model-modal :global(.ui-segmented) {
    background: var(--muted);
  }

  .model-trigger:focus-visible,
  .model-modal button:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }

  /* The same slim bar as the browser panel's. */
  .picker-bar {
    display: flex;
    height: 2.75rem;
    flex-shrink: 0;
    align-items: center;
    gap: 0.125rem;
    padding: 0 0.5rem 0 0.75rem;
  }
  .picker-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--foreground);
  }

  .picker-search {
    height: 2rem;
    flex-shrink: 0;
    margin: 0 0.75rem 0.375rem;
    padding: 0 0.75rem;
  }
  .picker-search input {
    font-size: 13px;
  }
  .picker-search input::-webkit-search-cancel-button {
    display: none;
  }

  /* Loading, a switch to confirm, a provider's error: one quiet inset row. */
  .picker-note {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.5rem;
    margin: 0 0.75rem 0.375rem;
    padding: 0.4rem 0.4rem 0.4rem 0.75rem;
    border-radius: 0.625rem;
    background: var(--muted);
    color: var(--text-secondary);
    font-size: 12px;
  }
  .picker-note.is-inline {
    margin: 0.125rem 0 0.25rem;
  }

  .model-list {
    min-height: 0;
    flex: 1;
    overflow-y: auto;
    padding: 0.25rem 0.5rem 0.5rem;
    overscroll-behavior: contain;
  }

  .provider-group + .provider-group {
    margin-top: 0.125rem;
  }

  /* A provider is a label over its models, not a row competing with them. */
  .group-head {
    display: flex;
    width: 100%;
    height: 2rem;
    align-items: center;
    gap: 0.5rem;
    padding: 0 0.625rem;
    border-radius: var(--radius-full);
    color: var(--muted-foreground);
    font-size: 12px;
    text-align: left;
    transition: color var(--motion-fast) var(--motion-ease);
  }
  .group-head:hover {
    color: var(--foreground);
  }
  .group-name {
    font-weight: 600;
    color: var(--foreground);
  }
  .group-meta {
    font-size: 11px;
  }
  .group-current {
    min-width: 0;
    max-width: 50%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11.5px;
  }
  .group-head :global(.group-chevron) {
    transition: transform var(--motion-fast) var(--motion-ease);
  }
  .group-models {
    padding-bottom: 0.375rem;
  }
  .group-hint {
    padding: 0.25rem 0.625rem 0.25rem 2.125rem;
    color: var(--muted-foreground);
    font-size: 11.5px;
  }

  .model-row {
    display: flex;
    width: 100%;
    height: 1.875rem;
    align-items: center;
    gap: 0.5rem;
    padding: 0 0.3rem 0 0.625rem;
    border-radius: var(--radius-full);
    color: var(--foreground);
    font-size: 12.5px;
    text-align: left;
    transition: background-color var(--motion-fast) var(--motion-ease);
  }
  .model-row:hover,
  .model-row:focus-visible,
  .model-row.is-selected {
    background: var(--surface-hover);
  }
  .model-row:disabled {
    cursor: wait;
    opacity: 0.65;
  }
  .model-row.is-local {
    height: 2.125rem;
  }
  .row-mark {
    display: inline-flex;
    width: 0.875rem;
    flex-shrink: 0;
    justify-content: center;
    color: var(--text-secondary);
  }
  .row-id {
    min-width: 0;
    max-width: 45%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted-foreground);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
  }
  .row-tag {
    flex-shrink: 0;
    padding-right: 0.4rem;
    color: var(--muted-foreground);
    font-size: 10.5px;
  }

  .picker-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.375rem;
    padding: 2.5rem 1rem;
    color: var(--muted-foreground);
    font-size: 12px;
    text-align: center;
  }
  .picker-empty p {
    color: var(--foreground);
    font-size: 13px;
    font-weight: 500;
  }
  .picker-empty .ui-chip {
    margin-top: 0.375rem;
  }

  .picker-footer {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.5rem 1rem 0.625rem;
    color: var(--muted-foreground);
    font-size: 11px;
  }
  .picker-key-hint {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }
  .picker-key-hint kbd {
    padding: 0 4px;
    border-radius: 4px;
    background: var(--muted);
    font: inherit;
  }

  @media (max-width: 560px) {
    .picker-key-hint,
    .row-id {
      display: none;
    }
  }
</style>

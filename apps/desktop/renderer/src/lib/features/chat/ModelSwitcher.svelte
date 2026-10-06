<svelte:options runes={true} />

<script lang="ts">
  import { Button } from '$lib/components/ui';
  import { untrack } from 'svelte';
  import { get } from 'svelte/store';
  import { Check, ChevronDown, ChevronRight, Cpu, LoaderCircle, Play, Power, RefreshCw, Search, Settings2, Square, X } from 'lucide-svelte';
  import { backdropIn, backdropOut, dialogIn, dialogOut } from '$lib/utils/transitions';
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
  import type { ModelOption, ChatSession } from '$lib/types/chat';
  import { buildLocalModelSecondaryText, formatContextLength, localModelMatchesSearch } from '$lib/utils/local-models';
  import { configuredProviders, defaultBaseUrl } from '$lib/utils/providers';

  let { compact = false, chat = null }: { compact?: boolean; chat?: ChatSession | null } = $props();

  let ownOpen = $state(false);
  const menuOpen = $derived(chat ? ownOpen : appStore.modelMenuOpen);
  function setOpen(value: boolean) { if(chat)ownOpen=value;else appStore.modelMenuOpen=value; }
  const ownSelection = $derived(chat?.modelSelection);
  const ownBackend = $derived(ownSelection?.backendMode ?? appStore.backendMode);
  const ownProvider = $derived(ownSelection?.provider ?? appStore.activeProviderName);
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
  let showAll = $state<Record<string, boolean>>({});
  let changingMode = $state(false);
  let panelEl = $state<HTMLDivElement>();
  const dialogId = $props.id();

  const activeProvider = $derived(appStore.activeProvider);
  const displayLabel = $derived(ownSelection ? ownSelection.backendMode === 'local' ? ownSelection.localModel : ownSelection.model : appStore.activeModelLabel);
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

  // Filter/sort each provider once per change, not again for every header,
  // count, expansion check and rendered row.
  const groupedModels = $derived.by(() => {
    const q = modelSearch.trim().toLowerCase();
    return new Map(configured.map(provider => {
      const list = providerModels.models(provider.id);
      const matchesProvider = provider.label.toLowerCase().includes(q);
      const matches = !q || matchesProvider ? list : list.filter(model => model.name.toLowerCase().includes(q) || model.id.toLowerCase().includes(q));
      const selected = provider.id === appStore.activeProviderName ? activeProvider?.model : '';
      return [provider.id, matches.slice().sort((a, b) => Number(b.id === selected) - Number(a.id === selected) || a.name.localeCompare(b.name))] as const;
    }));
  });
  function modelsForProvider(id: string): ModelOption[] { return groupedModels.get(id) ?? []; }

  const visibleProviders = $derived(configured.filter((provider) => !modelSearch.trim() || modelsForProvider(provider.id).length || providerModels.loading[provider.id] || providerModels.errors[provider.id]));
  const resultCount = $derived(appStore.backendMode === 'api' ? visibleProviders.reduce((sum, provider) => sum + modelsForProvider(provider.id).length, 0) : filteredModels.length);

  function isProviderExpanded(id: string): boolean {
    if (modelSearch.trim()) {
      return modelsForProvider(id).length > 0 || expandedProviders[id] === true;
    }
    // Open the active group immediately so arrow keys reach actual choices.
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
      setOpen(false);
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
    setOpen(false);
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
    setOpen(false);
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
    setOpen(false);
    await appStore.openLocalModelLoadDialog(model);
  }

  /** Cloud refreshes every configured group shown by this picker. */
  const refreshing = $derived(appStore.backendMode === 'api' ? configured.some(provider => providerModels.loading[provider.id]) : appStore.modelsRefreshing);

  function refresh() {
    modelsStore.refreshStatus();
    if (appStore.backendMode === 'api') {
      void Promise.all(configured.map(provider => providerModels.load(provider.id, true)))
        .then(() => appStore.refreshModels())
        .then(() => appStore.refreshReasoningCapabilities(true));
    } else if (isElectron()) {
      void appStore.refreshModels(true);
    }
  }

  function openManager(section: 'providers' | 'explore') {
    setOpen(false);
    appStore.openSettings(section);
  }

  function toggleMenu() {
    if(chat && appStore.currentChatId!==chat.id)appStore.selectChat(chat.id);
    if (menuOpen) {
      setOpen(false);
      return;
    }
    setOpen(true);
  }

  function initCloudListWhenOpen() {
    // Must not be tracked by the open/close effect (would re-run forever).
    untrack(() => {
      if (appStore.backendMode !== 'api') return;
      const active = appStore.activeProviderName;
      if (!active) return;
      expandedProviders = { [active]: true };
      showAll = {};
      for (const provider of configured) void providerModels.load(provider.id);
    });
  }

  // Stable open/close: only depend on modelMenuOpen — never write expanded/models here without untrack.
  $effect(() => {
    const open = menuOpen;
    if (!open) {
      modelSearch = '';
      confirmSwitch = null;
      return;
    }

    initCloudListWhenOpen();
    // Focus search once the modal lands.
    const focusTimer = requestAnimationFrame(() => searchInput?.focus());

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
      cancelAnimationFrame(focusTimer);
      document.removeEventListener('keydown', handleKeydown);
    };
  });

  // Search all configured providers, including groups that haven't been opened.
  $effect(() => {
    if (!menuOpen || appStore.backendMode !== 'api' || !modelSearch.trim()) return;
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
  class:is-open={menuOpen}
  class:is-compact={compact}
  style="-webkit-app-region: no-drag; pointer-events: auto;"
  onclick={toggleMenu}
  aria-haspopup="dialog"
  aria-expanded={menuOpen}
  aria-controls={dialogId}
  aria-label={$t('modelPicker.triggerLabel', { values: { model: displayLabel || $t('modelPicker.onDevice') } })}
>
  {#if ownBackend === 'local'}
    <Cpu class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
  {:else}
    <ProviderIcon provider={ownProvider} size={15} />
  {/if}
  <span class="trigger-label truncate">
    {#if ownBackend === 'local' && isAnyModelLoaded}
      {chat ? displayLabel || loadedModelFilename : loadedModelFilename}
    {:else if ownBackend === 'local'}
      {$t('modelPicker.onDevice')}
    {:else}
      {displayLabel || $t('modelPicker.selectModel')}
    {/if}
  </span>
  <ChevronDown class="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150 {menuOpen ? 'rotate-180' : ''}" />
</button>

<!-- Modal: portaled to body so Electron titlebar drag region cannot swallow clicks.
     Gray backdrop fills the window; square panel sits centered with fade/scale. -->
{#if menuOpen}
  <div use:portalToBody use:modalLayer={{ onclose: () => (setOpen(false)), dim: true }} class="model-modal-root fixed inset-0">
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="model-modal-backdrop absolute inset-0" onclick={() => (setOpen(false))} in:backdropIn out:backdropOut></div>
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
          <Tooltip label={$t('modelPicker.close')} position="bottom"><button type="button" class="ui-icon-button is-sm" onclick={() => (setOpen(false))} aria-label={$t('modelPicker.close')}><X /></button></Tooltip>
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
            <Tooltip label={$t('modelPicker.clearSearch')} position="bottom"><button type="button" class="ui-icon-button is-xs -mr-1.5" aria-label={$t('modelPicker.clearSearch')} onclick={() => (modelSearch = '')}><X /></button></Tooltip>
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
            <Button variant="outline" size="sm" type="button" onclick={() => (confirmSwitch = null)}>{$t('modelPicker.cancel')}</Button>
            <Button variant="default" size="sm" type="button" onclick={confirmSwitchModel}><Power /> {$t('modelPicker.switch')}</Button>
          </div>
        {/if}

        {#snippet empty(title: string, hint: string, action: string, onaction: () => void)}
          <div class="picker-empty">
            <p>{title}</p>
            <span>{hint}</span>
            <Button variant="outline" size="sm" type="button" onclick={onaction}>{action}</Button>
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
                    <div class="group-models" >
                      {#if providerModels.errors[prov.id]}
                        <div class="picker-note is-inline" role="status">
                          <span class="min-w-0 flex-1">{providerModels.errors[prov.id]}</span>
                          <Button variant="outline" size="sm" type="button" disabled={loading} onclick={() => void providerModels.load(prov.id, true)}>{$t('modelPicker.retry')}</Button>
                        </div>
                      {/if}
                      {#if list.length === 0}
                        <p class="group-hint">{loading ? $t('modelPicker.loading') : modelSearch ? $t('modelPicker.noMatches') : $t('modelPicker.noProviderModels')}</p>
                      {:else}
                        {#each (showAll[prov.id] ? list : list.slice(0, 50)) as model (model.id)}
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
                            {#if model.availability === 'retired'}<span class="row-id" title={$t('modelPicker.retiredHint')}>{$t('modelPicker.retired')}</span>
                            {:else if model.availability === 'catalog'}<span class="row-id" title={$t('modelPicker.notListedHint')}>{$t('modelPicker.notListed')}</span>{/if}
                            {#if selected}<span class="row-tag">{$t('modelPicker.inUse')}</span>{/if}
                          </button>
                        {/each}
                        {#if list.length > 50 && !showAll[prov.id]}
                          <button type="button" class="group-head" onclick={() => { showAll = { ...showAll, [prov.id]: true }; }}>{$t('code.showAll')} · {list.length}</button>
                        {/if}
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
                    <Button variant="outline" size="sm" class="text-error" type="button" onclick={handleUnload} disabled={unloading}>
                      {#if unloading}<LoaderCircle class="animate-spin" />{:else}<Square />{/if}
                      {$t('modelPicker.unload')}
                    </Button>
                  {:else}
                    <Button variant="outline" size="sm"
                      type="button"
                      onclick={async (e) => {
                        e.stopPropagation();
                        await handleLoad(model);
                      }}
                      disabled={localLoading}
                      data-model-option
                    >
                      {#if loadingTarget}<LoaderCircle class="animate-spin" /> {$t('modelPicker.loading')}{:else}<Play /> {$t('modelPicker.load')}{/if}
                    </Button>
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
    font-size: var(--text-sm);
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

  }

  .model-modal {
    width: min(560px, calc(100vw - 32px));
    max-height: min(680px, calc(100dvh - 48px));
    background: var(--float-bg);
    border: 1px solid var(--float-border);
    border-radius: var(--radius-2xl);
    box-shadow: var(--float-shadow);
    -webkit-app-region: no-drag;
    transform-origin: 50% 40%;

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
    font-size: var(--text-sm);
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
    font-size: var(--text-sm);
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
    font-size: var(--text-xs);
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
    font-size: var(--text-xs);
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
    font-size: var(--text-xs);
  }
  .group-current {
    min-width: 0;
    max-width: 50%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: var(--text-xs);
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
    font-size: var(--text-xs);
  }

  .model-row {
    display: flex;
    width: 100%;
    min-height: 2.25rem;
    align-items: center;
    gap: 0.5rem;
    padding: 0 0.3rem 0 0.625rem;
    border-radius: var(--radius-md);
    color: var(--foreground);
    font-size: var(--text-sm);
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
    font-size: var(--text-xs);
  }
  .row-tag {
    flex-shrink: 0;
    padding-right: 0.4rem;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
  }

  .picker-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.375rem;
    padding: 2.5rem 1rem;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    text-align: center;
  }
  .picker-empty p {
    color: var(--foreground);
    font-size: var(--text-sm);
    font-weight: 500;
  }

  .picker-footer {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.5rem 1rem 0.625rem;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
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

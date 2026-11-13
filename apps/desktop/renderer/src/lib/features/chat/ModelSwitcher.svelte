<svelte:options runes={true} />

<!--
  Every model, cloud and on-device, in one searchable list. The composer's
  model menu opens it from "All models…" (and from a provider in "Cloud ›").
  The filter at the top only narrows the list: what a chat runs on is decided
  by the model you pick, never by the filter, so browsing Cloud does not stop
  the model loaded on this computer.
-->

<script lang="ts">
  import EmptyState from '$lib/components/ui/EmptyState.svelte';
  import UiListRow from '$lib/components/ui/ListRow.svelte';

  import UiIconButton from '$lib/components/ui/IconButton.svelte';
  import UiInput from '$lib/components/ui/Input.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { Button } from '$lib/components/ui';
  import { untrack } from 'svelte';
  import { get } from 'svelte/store';
  import { Check, ChevronRight, Cpu, LoaderCircle, RefreshCw, Search, Settings2, Square, X } from '$lib/icons';
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
  import { recentModels } from '$lib/stores/recent-models.svelte';

  type Source = 'all' | 'cloud' | 'local';

  let {
    open = $bindable(false),
    chat = null,
    source: initialSource = 'all',
    provider: focusProvider = null
  }: {
    open?: boolean;
    chat?: ChatSession | null;
    /** Which models the list starts on; the filter changes it, nothing else. */
    source?: Source;
    /** A provider group to open first (from "Cloud › <provider>"). */
    provider?: string | null;
  } = $props();

  const menuOpen = $derived(open);
  function setOpen(value: boolean) { open = value; }
  let source = $state<Source>('all');
  const showCloud = $derived(source !== 'local');
  const showLocal = $derived(source !== 'cloud' && isElectron());
  const loadedModelName = $derived(appStore.localModelActive?.name || '');
  const loadedModelPath = $derived(appStore.localModelActive?.path?.toLowerCase() || '');

  let modelSearch = $state('');
  let searchInput = $state<HTMLInputElement | undefined>(undefined);
  let unloading = $state(false);
  let expandedProviders = $state<Record<string, boolean>>({});
  let selectingModel = $state('');
  let showAll = $state<Record<string, boolean>>({});
  let changingMode = $state(false);
  let panelEl = $state<HTMLDivElement>();
  const dialogId = $props.id();

  const activeProvider = $derived(appStore.activeProvider);
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

  // The models on this computer, whatever the chat runs on right now.
  const localModels = $derived<ModelOption[]>((modelsStore.availableModels ?? []).map((m) => ({ ...m, source: 'local' as const })));
  const filteredModels = $derived(modelSearch.trim() ? localModels.filter((m) => localModelMatchesSearch(m, modelSearch)) : localModels);

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
  const resultCount = $derived((showCloud ? visibleProviders.reduce((sum, provider) => sum + modelsForProvider(provider.id).length, 0) : 0) + (showLocal ? filteredModels.length : 0));

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

  async function selectCloudModel(providerId: string, modelId: string, name = modelId) {
    if (selectingModel || changingMode) return;
    if (chat && appStore.currentChatId !== chat.id) appStore.selectChat(chat.id);
    const already = providerId === appStore.activeProviderName && modelId === activeProvider?.model;
    if (already && appStore.backendMode === 'api') {
      setOpen(false);
      return;
    }
    selectingModel = `${providerId}/${modelId}`;
    const saved = appStore.config.llm?.providers?.[providerId];
    try {
      if (appStore.backendMode !== 'api') await appStore.setBackendMode('api');
      if (!already) await appStore.updateProvider({
        provider: providerId,
        base_url: saved?.base_url || defaultBaseUrl(providerId),
        model: modelId
      });
      recentModels.remember({ kind: 'cloud', provider: providerId, model: modelId, name });
    } catch (err) {
      toastStore.error(get(t)('modelPicker.switchFailed'));
      return;
    } finally {
      selectingModel = '';
    }
    setOpen(false);
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
      model.chat_template_uses_tools === true ? 'tools' : ''
    ]
      .filter(Boolean);
    return parts.join(' • ');
  }

  /**
   * A local row: the loaded model is picked at once; any other one opens its
   * load settings (context, GPU offload, thinking…), where Load replaces the
   * running model. Nothing loads on a click alone.
   */
  async function pickLocal(model: ModelOption) {
    if (!model.path || localLoading) return;
    if (chat && appStore.currentChatId !== chat.id) appStore.selectChat(chat.id);
    setOpen(false);
    if (isLoaded(model)) {
      if (appStore.backendMode !== 'local') await appStore.setBackendMode('local');
      recentModels.remember({ kind: 'local', id: model.id, name: model.name, path: model.path });
      return;
    }
    await appStore.openLocalModelLoadDialog(model);
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

  /** Cloud refreshes every configured group shown by this picker. */
  const refreshing = $derived(configured.some(provider => providerModels.loading[provider.id]) || appStore.modelsRefreshing);

  function refresh() {
    modelsStore.refreshStatus();
    if (showLocal) void modelsStore.refreshIndex?.();
    if (showCloud) {
      void Promise.all(configured.map(provider => providerModels.load(provider.id, true)))
        .then(() => appStore.refreshModels())
        .then(() => appStore.refreshReasoningCapabilities(true));
    }
  }

  function openManager(section: 'providers' | 'explore') {
    setOpen(false);
    appStore.openSettings(section);
  }

  function initCloudListWhenOpen() {
    // Must not be tracked by the open/close effect (would re-run forever).
    untrack(() => {
      source = initialSource;
      const active = focusProvider || appStore.activeProviderName;
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
    if (!menuOpen || !showCloud || !modelSearch.trim()) return;
    const timer = setTimeout(() => untrack(() => {
      for (const provider of configured) void providerModels.load(provider.id);
    }), 180);
    return () => clearTimeout(timer);
  });
</script>

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
            <SegmentedControl value={source} options={[{ value: 'all', label: $t('modelPicker.filterAll') }, { value: 'cloud', label: $t('modelPicker.cloud') }, { value: 'local', label: $t('modelPicker.onDevice') }]} label={$t('modelPicker.filter')} onchange={(value) => (source = value as Source)} />
          {:else}
            <span class="picker-title">{$t('modelPicker.title')}</span>
          {/if}
          <span class="flex-1"></span>
          <Tooltip label={$t('modelPicker.refresh')} position="bottom">
            <UiIconButton label={$t('modelPicker.refresh')} size="xs" type="button" class={uiClass(" ", "ui-local-8157c6d7")} onclick={refresh}  disabled={refreshing}>
              <RefreshCw class={refreshing ? 'animate-spin' : ''} />
            </UiIconButton>
          </Tooltip>
          {#if showCloud}
            <Tooltip label={$t('modelPicker.manageProviders')} position="bottom">
              <UiIconButton label={$t('modelPicker.manageProviders')} size="xs" type="button" class={uiClass(" ", "ui-local-8157c6d7")} onclick={() => openManager('providers')} >
                <Settings2 />
              </UiIconButton>
            </Tooltip>
          {/if}
          <Tooltip label={$t('modelPicker.close')} position="bottom"><UiIconButton label={$t('modelPicker.close')} size="xs" type="button" class={uiClass(" ", "ui-local-8157c6d7")} onclick={() => (setOpen(false))} ><X /></UiIconButton></Tooltip>
        </div>

        <label class="ui-pill-field picker-search">
          <Search class="size-3.5 shrink-0 text-muted-foreground" />
          <UiInput class={uiClass('', "ui-local-8157c6d7")}
            bind:ref={searchInput}
            bind:value={modelSearch}
            type="search"
            aria-label={$t('modelPicker.search')}
            placeholder={$t('modelPicker.searchPlaceholder')}
            onclick={(e) => e.stopPropagation()}
          />
          {#if modelSearch}
            <Tooltip label={$t('modelPicker.clearSearch')} position="bottom"><UiIconButton label={$t('modelPicker.clearSearch')} size="xs" type="button" class={uiClass("  -mr-1.5", "ui-local-8157c6d7")}  onclick={() => (modelSearch = '')}><X /></UiIconButton></Tooltip>
          {/if}
        </label>

        {#if localLoading}
          <div class="picker-note" role="status">
            <LoaderCircle class="size-3.5 shrink-0 animate-spin" />
            <span>{$t('modelPicker.loadingModel')}</span>
          </div>
        {/if}

        {#snippet empty(title: string, hint: string, action: string, onaction: () => void)}
          <EmptyState align="start" size="compact" {title} description={hint} {action} {onaction} />
        {/snippet}

        <div class="model-list" aria-label={$t('modelPicker.available')} aria-busy={changingMode}>
          <!-- This computer first: private, free, and shared by every chat. -->
          {#if showLocal && (localModels.length || source === 'local')}
            <div class="provider-group">
              <div class={uiClass("group-head is-static", "ui-local-8157c6d7")}>
                <Cpu class="size-3.5 shrink-0" />
                <span class="group-name">{$t('modelPicker.onDevice')}</span>
                <span class="group-meta">· {$t('modelPicker.forAllChats')}</span>
              </div>
              {#if !localModels.length}
                {@render empty($t('modelPicker.noLocal'), $t('modelPicker.noLocalHint'), $t('modelPicker.explore'), () => openManager('explore'))}
              {:else if filteredModels.length === 0}
                <p class="group-hint">{$t('modelPicker.noMatches')}</p>
              {:else}
                <div class="group-models">
                  {#each filteredModels as model (model.id)}
                    {@const loaded = isLoaded(model)}
                    {@const loadingTarget = isLoadingModel(model)}
                    <div class="local-line">
                      <UiListRow
                        type="button"
                        class={uiClass("model-row", "ui-local-8157c6d7", {"is-selected": loaded})}
                        data-model-option
                        aria-pressed={loaded}
                        disabled={localLoading || !model.path}
                        onclick={(e) => { e.stopPropagation(); void pickLocal(model); }}
                      >
                        <span class="row-mark">
                          {#if loadingTarget}<LoaderCircle class="size-3.5 animate-spin" />
                          {:else if loaded}<Check class="size-3.5" />{/if}
                        </span>
                        <span class="min-w-0 flex-1 truncate">{model.name}</span>
                        {#if metaLine(model)}<span class="row-id">{metaLine(model)}</span>{/if}
                      </UiListRow>
                      {#if loaded}
                        <Tooltip label={$t('modelPicker.unload')} position="bottom">
                          <UiIconButton label={$t('modelPicker.unload')} size="xs" type="button" class={uiClass("hover:text-error", "ui-local-8157c6d7")} onclick={handleUnload} disabled={unloading}>
                            {#if unloading}<LoaderCircle class="animate-spin" />{:else}<Square />{/if}
                          </UiIconButton>
                        </Tooltip>
                      {/if}
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}

          {#if showCloud}
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
                  <Button variant="plain"
                    type="button"
                    class={uiClass("group-head", "ui-local-8157c6d7")}
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
                  </Button>

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
                          <UiListRow
                            type="button"
                            class={uiClass("model-row", "ui-local-8157c6d7", {"is-selected": selected})}

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
                            {#if model.availability === 'catalog'}<span class="row-id" title={$t('modelPicker.notListedHint')}>{$t('modelPicker.notListed')}</span>{/if}
                            {#if selected}<span class="row-tag">{$t('modelPicker.inUse')}</span>{/if}
                          </UiListRow>
                        {/each}
                        {#if list.length > 50 && !showAll[prov.id]}
                          <Button variant="plain" type="button" class={uiClass("group-head", "ui-local-8157c6d7")} onclick={() => { showAll = { ...showAll, [prov.id]: true }; }}>{$t('code.showAll')} · {list.length}</Button>
                        {/if}
                      {/if}
                    </div>
                  {/if}
                </div>
              {/each}
            {/if}
          {/if}
        </div>

        <footer class="picker-footer">
          <span aria-live="polite">{$t(modelSearch ? 'modelPicker.countFound' : 'modelPicker.countAvailable', { values: { n: resultCount } })}</span>
        </footer>
      </div>
    </div>
  </div>
{/if}

<style>
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

  .model-modal :global(button:focus-visible.ui-local-8157c6d7) {
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
  .picker-search :global(input.ui-local-8157c6d7) {
    font-size: var(--text-sm);
  }
  .picker-search :global(input.ui-local-8157c6d7::-webkit-search-cancel-button) {
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
  :global(.group-head.ui-local-8157c6d7) {
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
  :global(.group-head:hover.ui-local-8157c6d7) {
    color: var(--foreground);
  }
  :global(.group-head.is-static.ui-local-8157c6d7) { cursor: default; }
  .local-line {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }
  .local-line > :global(.model-row) { flex: 1; min-width: 0; }
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
  :global(.group-head.ui-local-8157c6d7) :global(.group-chevron) {
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

  :is(.model-row, :global(.model-row.ui-local-8157c6d7)) {
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
  :is(.model-row:hover, :global(.model-row:hover.ui-local-8157c6d7)),
  :is(.model-row:focus-visible, :global(.model-row:focus-visible.ui-local-8157c6d7)),
  :is(.model-row.is-selected, :global(.model-row.is-selected.ui-local-8157c6d7)) {
    background: var(--surface-hover);
  }
  :is(.model-row:disabled, :global(.model-row:disabled.ui-local-8157c6d7)) {
    cursor: wait;
    opacity: 0.65;
  }
  :is(.model-row.is-local, :global(.model-row.is-local.ui-local-8157c6d7)) {
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

  @media (max-width: 560px) {
    .row-id {
      display: none;
    }
  }
</style>

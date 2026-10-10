<svelte:options runes={true} />

<!--
  The one model list.

  A provider group per configured provider, a search field over all of them,
  arrow keys that walk the rows, and a count in the footer. The composer's
  switcher and every pin (a subagent type, the compaction model) open this, so
  choosing a model reads the same wherever it is asked for.

  `rows` replaces the cloud list for a caller with a different body (the
  composer's on-device branch); the shell, the search and the footer stay.
-->

<script lang="ts">
  import UiListRow from '$lib/components/ui/ListRow.svelte';

  import UiIconButton from '$lib/components/ui/IconButton.svelte';
  import UiInput from '$lib/components/ui/Input.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { Button } from '$lib/components/ui';
  import type { Snippet } from 'svelte';
  import { Check, ChevronRight, LoaderCircle, RefreshCw, Search, Settings2, X } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import { backdropIn, backdropOut, dialogIn, dialogOut } from '$lib/utils/transitions';
  import { modalLayer } from '$lib/components/ui/modal-layer';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import ProviderIcon from '$lib/components/ui/ProviderIcon.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { providerModels } from '$lib/stores/provider-models.svelte';
  import { configuredProviders } from '$lib/utils/providers';

  let {
    open = $bindable(false),
    title,
    selected = null,
    onpick,
    onmanage,
    bar,
    note,
    rows
  }: {
    open?: boolean;
    title?: string;
    /** The pin in effect, so its row is marked and sorted first. */
    selected?: { provider: string; model: string } | null;
    onpick: (provider: string, model: string) => void;
    /** Opens provider settings; hides the button when absent. */
    onmanage?: () => void;
    /** Controls at the left of the bar (the composer's source switch). */
    bar?: Snippet;
    /** One quiet inset row above the list (loading, a switch to confirm). */
    note?: Snippet;
    /** A different list body. */
    rows?: Snippet;
  } = $props();

  let search = $state('');
  let searchInput = $state<HTMLInputElement | undefined>(undefined);
  let panelEl = $state<HTMLDivElement>();
  let expanded = $state<Record<string, boolean>>({});
  let showAll = $state<Record<string, boolean>>({});
  const dialogId = $props.id();

  const providers = $derived(configuredProviders(appStore.config, { includeActiveAlways: true }));
  const refreshing = $derived(providers.some((provider) => providerModels.loading[provider.id]));

  // Filter/sort each provider once per change, not again for every header,
  // count, expansion check and rendered row.
  const grouped = $derived.by(() => {
    const query = search.trim().toLowerCase();
    return new Map(providers.map((provider) => {
      const list = providerModels.models(provider.id);
      const matches = !query || provider.label.toLowerCase().includes(query)
        ? list
        : list.filter((model) => model.name.toLowerCase().includes(query) || model.id.toLowerCase().includes(query));
      return [provider.id, matches.slice().sort((a, b) =>
        Number(b.id === selected?.model && provider.id === selected.provider) - Number(a.id === selected?.model && provider.id === selected.provider)
        || a.name.localeCompare(b.name))] as const;
    }));
  });
  const modelsFor = (id: string) => grouped.get(id) ?? [];
  const visible = $derived(providers.filter((provider) => !search.trim() || modelsFor(provider.id).length || providerModels.loading[provider.id] || providerModels.errors[provider.id]));
  const resultCount = $derived(visible.reduce((sum, provider) => sum + modelsFor(provider.id).length, 0));

  const isExpanded = (id: string) => (search.trim() ? modelsFor(id).length > 0 || expanded[id] === true : expanded[id] === true);

  function toggleProvider(id: string) {
    const next = !isExpanded(id);
    expanded = { ...expanded, [id]: next };
    if (next) void providerModels.load(id);
  }

  function refresh() {
    void Promise.all(providers.map((provider) => providerModels.load(provider.id, true)));
  }

  function pick(providerId: string, modelId: string) {
    onpick(providerId, modelId);
    open = false;
  }

  // Open on the pin in effect, and load every group the search may reach.
  $effect(() => {
    if (!open) {
      search = '';
      return;
    }
    const active = selected?.provider;
    expanded = active ? { [active]: true } : {};
    showAll = {};
    for (const provider of providers) void providerModels.load(provider.id);
    const focus = requestAnimationFrame(() => searchInput?.focus());
    return () => cancelAnimationFrame(focus);
  });

  // A search reaches providers whose list has not been fetched yet.
  $effect(() => {
    if (!open || !search.trim()) return;
    const timer = setTimeout(() => { for (const provider of providers) void providerModels.load(provider.id); }, 180);
    return () => clearTimeout(timer);
  });

  function onKeydown(event: KeyboardEvent) {
    if (!panelEl) return;
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const list = [...panelEl.querySelectorAll<HTMLButtonElement>('[data-model-option]:not(:disabled)')];
    const current = list.findIndex((row) => row === document.activeElement);
    if (document.activeElement !== searchInput && current < 0) return;
    event.preventDefault();
    const next = current + (event.key === 'ArrowDown' ? 1 : -1);
    if (next < 0 && current >= 0) searchInput?.focus();
    else {
      const row = list[Math.min(list.length - 1, Math.max(0, next))];
      row?.focus();
      row?.scrollIntoView({ block: 'nearest' });
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
</script>

{#if open}
  <div use:portalToBody use:modalLayer={{ onclose: () => (open = false), dim: true }} class="model-modal-root fixed inset-0">
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="model-modal-backdrop absolute inset-0" onclick={() => (open = false)} in:backdropIn out:backdropOut></div>
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
        onkeydown={onKeydown}
        onclick={(e) => e.stopPropagation()}
        onpointerdown={(e) => e.stopPropagation()}
        in:dialogIn
        out:dialogOut
      >
        <h2 id={`${dialogId}-title`} class="sr-only">{title ?? $t('modelPicker.title')}</h2>

        <div class="picker-bar">
          {#if bar}{@render bar()}{:else}<span class="picker-title">{title ?? $t('modelPicker.title')}</span>{/if}
          <span class="flex-1"></span>
          <Tooltip label={$t('modelPicker.refresh')} position="bottom">
            <UiIconButton label={$t('modelPicker.refresh')} size="xs" type="button" class={uiClass(" ", "ui-local-6cbfdb91")} onclick={refresh}  disabled={refreshing}>
              <RefreshCw class={refreshing ? 'animate-spin' : ''} />
            </UiIconButton>
          </Tooltip>
          {#if onmanage}
            <Tooltip label={$t('modelPicker.manageProviders')} position="bottom">
              <UiIconButton label={$t('modelPicker.manageProviders')} size="xs" type="button" class={uiClass(" ", "ui-local-6cbfdb91")} onclick={onmanage} >
                <Settings2 />
              </UiIconButton>
            </Tooltip>
          {/if}
          <Tooltip label={$t('modelPicker.close')} position="bottom"><UiIconButton label={$t('modelPicker.close')} size="xs" type="button" class={uiClass(" ", "ui-local-6cbfdb91")} onclick={() => (open = false)} ><X /></UiIconButton></Tooltip>
        </div>

        <label class="ui-pill-field picker-search">
          <Search class="size-3.5 shrink-0 text-muted-foreground" />
          <UiInput class={uiClass('', "ui-local-6cbfdb91")}
            bind:ref={searchInput}
            bind:value={search}
            type="search"
            aria-label={$t('modelPicker.search')}
            placeholder={$t('modelPicker.searchPlaceholder')}
          />
          {#if search}
            <Tooltip label={$t('modelPicker.clearSearch')} position="bottom"><UiIconButton label={$t('modelPicker.clearSearch')} size="xs" type="button" class={uiClass("  -mr-1.5", "ui-local-6cbfdb91")}  onclick={() => (search = '')}><X /></UiIconButton></Tooltip>
          {/if}
        </label>

        {#if note}{@render note()}{/if}

        <div class="model-list" aria-label={$t('modelPicker.available')}>
          {#if rows}
            {@render rows()}
          {:else if !providers.length}
            <div class="picker-empty">
              <p>{$t('modelPicker.noProviders')}</p>
              <span>{$t('modelPicker.noProvidersHint')}</span>
              {#if onmanage}<Button variant="outline" size="sm" type="button" onclick={onmanage}>{$t('modelPicker.configureProvider')}</Button>{/if}
            </div>
          {:else if !visible.length}
            <div class="picker-empty">
              <p>{$t('modelPicker.noResults')}</p>
              <span>{$t('modelPicker.noResultsHint')}</span>
              <Button variant="outline" size="sm" type="button" onclick={() => (search = '')}>{$t('modelPicker.clearSearch')}</Button>
            </div>
          {:else}
            {#each visible as provider (provider.id)}
              {@const openGroup = isExpanded(provider.id)}
              {@const list = modelsFor(provider.id)}
              {@const loading = !!providerModels.loading[provider.id]}
              <div class="provider-group">
                <Button variant="plain" type="button" class={uiClass("group-head", "ui-local-6cbfdb91")} onclick={() => toggleProvider(provider.id)} aria-expanded={openGroup}>
                  <ProviderIcon provider={provider.id} size={14} />
                  <span class="group-name">{provider.label}</span>
                  {#if provider.isActive}<span class="group-meta">· {$t('modelPicker.connected')}</span>{/if}
                  <span class="flex-1"></span>
                  {#if loading}<LoaderCircle class="size-3 shrink-0 animate-spin" />{/if}
                  {#if provider.model && !openGroup}<span class="group-current">{provider.model}</span>{/if}
                  <ChevronRight class="group-chevron size-3.5 shrink-0 {openGroup ? 'rotate-90' : ''}" />
                </Button>

                {#if openGroup}
                  <div class="group-models">
                    {#if providerModels.errors[provider.id]}
                      <div class="picker-note is-inline" role="status">
                        <span class="min-w-0 flex-1">{providerModels.errors[provider.id]}</span>
                        <Button variant="outline" size="sm" type="button" disabled={loading} onclick={() => void providerModels.load(provider.id, true)}>{$t('modelPicker.retry')}</Button>
                      </div>
                    {/if}
                    {#if list.length === 0}
                      <p class="group-hint">{loading ? $t('modelPicker.loading') : search ? $t('modelPicker.noMatches') : $t('modelPicker.noProviderModels')}</p>
                    {:else}
                      {#each (showAll[provider.id] ? list : list.slice(0, 50)) as model (model.id)}
                        {@const isSelected = selected?.provider === provider.id && selected.model === model.id}
                        <UiListRow
                          type="button"
                          class={uiClass("model-row", "ui-local-6cbfdb91", {"is-selected": isSelected})}

                          data-model-option
                          aria-pressed={isSelected}
                          onclick={() => pick(provider.id, model.id)}
                        >
                          <span class="row-mark">{#if isSelected}<Check class="size-3.5" />{/if}</span>
                          <span class="min-w-0 flex-1 truncate">{model.name}</span>
                          {#if model.id !== model.name}<span class="row-id">{model.id}</span>{/if}
                          {#if isSelected}<span class="row-tag">{$t('modelPicker.inUse')}</span>{/if}
                        </UiListRow>
                      {/each}
                      {#if list.length > 50 && !showAll[provider.id]}
                        <Button variant="plain" type="button" class={uiClass("group-head", "ui-local-6cbfdb91")} onclick={() => { showAll = { ...showAll, [provider.id]: true }; }}>{$t('code.showAll')} · {list.length}</Button>
                      {/if}
                    {/if}
                  </div>
                {/if}
              </div>
            {/each}
          {/if}
        </div>

        <footer class="picker-footer">
          <span aria-live="polite">{$t(search ? 'modelPicker.countFound' : 'modelPicker.countAvailable', { values: { n: resultCount } })}</span>
        </footer>
      </div>
    </div>
  </div>
{/if}

<style>
  .model-modal-root {
    -webkit-app-region: no-drag;
  }

  .model-modal-backdrop {
    background: var(--overlay);
  }

  .model-modal {
    width: min(720px, calc(100vw - 32px));
    max-height: min(820px, calc(100dvh - 40px));
    min-height: min(520px, calc(100dvh - 40px));
    background: var(--float-bg);
    border: 1px solid var(--float-border);
    border-radius: var(--radius-2xl);
    box-shadow: var(--float-shadow);
    -webkit-app-region: no-drag;
    transform-origin: 50% 40%;
  }

  .model-modal :global(button:focus-visible.ui-local-6cbfdb91) {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }

  /* The same slim bar as the browser panel's. */
  .picker-bar {
    display: flex;
    height: 3.25rem;
    flex-shrink: 0;
    align-items: center;
    gap: 0.125rem;
    padding: 0 0.625rem 0 1rem;
  }
  .picker-title {
    font-size: var(--text-base);
    font-weight: 600;
    color: var(--foreground);
  }

  .picker-search {
    height: 2.5rem;
    flex-shrink: 0;
    margin: 0 1rem 0.5rem;
    padding: 0 0.875rem;
  }
  .picker-search :global(input.ui-local-6cbfdb91) {
    font-size: var(--text-base);
  }
  .picker-search :global(input.ui-local-6cbfdb91::-webkit-search-cancel-button) {
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
    padding: 0.375rem 0.75rem 0.75rem;
    overscroll-behavior: contain;
  }

  .provider-group + .provider-group {
    margin-top: 0.125rem;
  }

  /* A provider is a label over its models, not a row competing with them. */
  :global(.group-head.ui-local-6cbfdb91) {
    display: flex;
    width: 100%;
    height: 2.25rem;
    align-items: center;
    gap: 0.5rem;
    padding: 0 0.75rem;
    border-radius: var(--radius-full);
    color: var(--muted-foreground);
    font-size: var(--text-sm);
    text-align: left;
    transition: color var(--motion-fast) var(--motion-ease);
  }
  :global(.group-head:hover.ui-local-6cbfdb91) {
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
  :global(.group-head.ui-local-6cbfdb91) :global(.group-chevron) {
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

  :global(.model-row.ui-local-6cbfdb91) {
    display: flex;
    width: 100%;
    min-height: 2.625rem;
    align-items: center;
    gap: 0.625rem;
    padding: 0 0.4rem 0 0.75rem;
    border-radius: var(--radius-md);
    color: var(--foreground);
    font-size: var(--text-base);
    text-align: left;
    transition: background-color var(--motion-fast) var(--motion-ease);
  }
  :global(.model-row:hover.ui-local-6cbfdb91),
  :global(.model-row:focus-visible.ui-local-6cbfdb91),
  :global(.model-row.is-selected.ui-local-6cbfdb91) {
    background: var(--surface-hover);
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
    align-items: flex-start;
    gap: 0.375rem;
    padding: 1.5rem 0.625rem;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
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
    padding: 0.625rem 1.25rem 0.75rem;
    color: var(--muted-foreground);
    font-size: var(--text-sm);
  }

  @media (max-width: 560px) {
    .row-id {
      display: none;
    }
  }
</style>

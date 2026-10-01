<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import { ChevronLeft, ChevronRight, Download, Ellipsis, Minus, Plus, Search, X } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import { closeViewerSearch, createViewerControls, useViewerControls, type ViewerAction } from './viewer-controls.svelte';

  let { title, onclose, ondownload, actions = [], beforeMenu, trail }: {
    title: string;
    onclose?: () => void;
    ondownload?: () => void;
    actions?: ViewerAction[];
    beforeMenu?: Snippet;
    trail?: Snippet;
  } = $props();
  const controls = useViewerControls() ?? createViewerControls();
  const caps = $derived(controls.current);
  const menuActions = $derived([...(caps?.actions ?? []), ...actions].filter(action => !ondownload || action.label !== $t('artifacts.card.download')));
  function findKeydown(event: KeyboardEvent) {
    if (closeViewerSearch(event, controls)) return;
    if (event.key === 'Enter') { event.preventDefault(); caps?.search?.step?.(event.shiftKey ? -1 : 1); }
  }
  let pageInput = $state('1');
  const searchable = $derived(!!caps?.search);
  let searchWasOpen = false;
  let searchToggle = $state<HTMLButtonElement>();
  let field = $state<HTMLInputElement>();
  let narrow = $state(false);
  let root = $state<HTMLElement>();
  $effect(() => { pageInput = String(caps?.page ?? 1); });
  $effect(() => {
    if (!root || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { narrow = (root?.clientWidth ?? 0) < 480; });
    observer.observe(root);
    return () => observer.disconnect();
  });
  $effect(() => {
    if (controls.searchOpen && searchable) { searchWasOpen = true; void tick().then(() => field?.focus()); }
    else if (searchWasOpen) { searchWasOpen = false; void tick().then(() => searchToggle?.focus()); }
  });
  function commitPage() {
    const page = Number(pageInput);
    if (Number.isInteger(page) && page >= 1 && page <= (caps?.pages ?? 0)) caps?.goToPage?.(page);
    pageInput = String(caps?.page ?? 1);
  }
</script>

<header class="viewer-toolbar" bind:this={root} aria-label={title}>
  <span class="viewer-title" title={title}>{controls.title || title}</span>
  {#if caps?.goToPage && caps.pages}
    <div class="page-controls">
      <button type="button" class="ui-icon-button is-sm" onclick={() => caps?.goToPage?.((caps.page ?? 1) - 1)} disabled={(caps.page ?? 1) <= 1} aria-label={$t('viewer.previous')}><ChevronLeft /></button>
      <input class="page-number" aria-label={$t('viewer.page', { values: { n: caps.page, total: caps.pages } })} inputmode="numeric" bind:value={pageInput} onblur={commitPage} onkeydown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitPage(); } else if (event.key === 'Escape') { event.stopPropagation(); pageInput = String(caps?.page ?? 1); event.currentTarget.blur(); } }} />
      <span class="page-total">/ {caps.pages}</span>
      <button type="button" class="ui-icon-button is-sm" onclick={() => caps?.goToPage?.((caps.page ?? 1) + 1)} disabled={(caps.page ?? 1) >= caps.pages} aria-label={$t('viewer.next')}><ChevronRight /></button>
    </div>
  {/if}
  {#if caps?.zoomBy}
    {#if !narrow}<button type="button" class="ui-icon-button is-sm" onclick={() => caps?.zoomBy?.(-1)} aria-label={$t('viewer.zoomOut')}><Minus /></button>{/if}
    <button type="button" class="zoom-label" onclick={() => caps?.fit?.()} disabled={!caps.fit} title={$t('viewer.fit')}>{caps.zoom}</button>
    {#if !narrow}<button type="button" class="ui-icon-button is-sm" onclick={() => caps?.zoomBy?.(1)} aria-label={$t('viewer.zoomIn')}><Plus /></button>{/if}
  {/if}
  {#if caps?.search}<button type="button" class="ui-icon-button is-sm" aria-label={$t('artifacts.reader.search')} aria-expanded={controls.searchOpen} bind:this={searchToggle} onclick={() => { controls.searchOpen = !controls.searchOpen; }}><Search /></button>{/if}
  {@render beforeMenu?.()}
  <Menu label={$t('browser.more')} placement="bottom-end">
    {#snippet trigger(props)}<button type="button" class="ui-icon-button is-sm" {...props} aria-label={$t('browser.more')}><Ellipsis /></button>{/snippet}
    {#if ondownload}<MenuItem label={$t('artifacts.card.download')} icon={Download} onselect={ondownload} />{/if}
    {#if narrow && caps?.zoomBy}
      <MenuItem label={$t('viewer.zoomOut')} icon={Minus} onselect={() => caps?.zoomBy?.(-1)} />
      <MenuItem label={$t('viewer.zoomIn')} icon={Plus} onselect={() => caps?.zoomBy?.(1)} />
    {/if}
    {#if caps?.fit}<MenuItem label={$t('viewer.fit')} onselect={() => caps?.fit?.()} />{/if}
    {#if caps?.retry}<MenuItem label={$t('chat.retry')} onselect={() => caps?.retry?.()} />{/if}
    {#each menuActions as action (action.label)}<MenuItem label={action.label} active={action.active} disabled={action.disabled} onselect={action.run} />{/each}
  </Menu>
  {@render trail?.()}
  {#if onclose}<button type="button" class="ui-icon-button is-sm" onclick={onclose} aria-label={$t('artifacts.reader.close')}><X /></button>{/if}
</header>
{#if controls.searchOpen && caps?.search}
  <div class="viewer-find">
    <Search class="size-3.5" />
    <input bind:this={field} bind:value={controls.query} aria-label={$t('artifacts.reader.search')} placeholder={$t('artifacts.reader.search')} onkeydown={findKeydown} />
    <span aria-live="polite">{caps.search.matches ? caps.search.index + 1 : 0}/{caps.search.matches}</span>
    {#if caps.search.step}
      <button type="button" class="ui-icon-button is-xs" onclick={() => caps?.search?.step?.(-1)} aria-label={$t('viewer.previous')}><ChevronLeft /></button>
      <button type="button" class="ui-icon-button is-xs" onclick={() => caps?.search?.step?.(1)} aria-label={$t('viewer.next')}><ChevronRight /></button>
    {/if}
    <button type="button" class="ui-icon-button is-xs" onclick={() => { controls.query = ''; controls.searchOpen = false; }} aria-label={$t('artifacts.clearSearch')}><X /></button>
  </div>
{/if}

<style>
  .viewer-toolbar { display:flex; height:36px; min-height:36px; flex-shrink:0; min-width:0; align-items:center; gap:2px; padding:0 5px; background:var(--card); color:var(--muted-foreground); font-size:12px; }
  .viewer-title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding:0 5px; color:var(--foreground); }
  .page-controls { display:flex; align-items:center; flex-shrink:0; gap:2px; font-variant-numeric:tabular-nums; }
  .page-number { width:3ch; max-width:40px; padding:2px 0; border:0; border-radius:4px; background:transparent; color:var(--foreground); text-align:center; font:inherit; }
  .page-number:focus { background:var(--muted); }
  .page-total { white-space:nowrap; font-size:11px; }
  .zoom-label { min-width:36px; padding:4px; font-size:11px; font-variant-numeric:tabular-nums; border-radius:999px; }
  .zoom-label:hover { background:var(--surface-hover); color:var(--foreground); }
  .viewer-find { display:flex; align-items:center; flex-shrink:0; gap:4px; margin:0 5px 4px; padding:2px 5px 2px 8px; height:28px; border-radius:999px; background:var(--muted); color:var(--muted-foreground); font-size:11px; }
  .viewer-find input { flex:1; width:0; min-width:0; border:0; outline:0; background:transparent; font:inherit; color:var(--foreground); }
  .viewer-toolbar :global(button:focus-visible), .page-number:focus-visible, .viewer-find:focus-within { outline:1px solid var(--muted-foreground); outline-offset:-1px; }
  .viewer-toolbar :global(button) { flex-shrink:0; }
</style>

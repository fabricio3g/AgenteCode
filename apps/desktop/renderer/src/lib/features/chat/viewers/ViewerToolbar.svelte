<script lang="ts">
  import UiToolbar from '$lib/components/ui/Toolbar.svelte';

  import UiIconButton from '$lib/components/ui/IconButton.svelte';
  import UiInput from '$lib/components/ui/Input.svelte';
  import UiButton from '$lib/components/ui/Button.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { observeViewerSize } from './viewer-layout';
  import { Tooltip } from '$lib/components/ui';
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
    return observeViewerSize(root, () => { narrow = (root?.clientWidth ?? 0) < 480; });
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

<UiToolbar wrap={false} as="header" density="compact" class={uiClass("viewer-toolbar", "ui-local-eaba586c")} bind:ref={root} aria-label={title}>
  <span class="viewer-title" title={title}>{controls.title || title}</span>
  {#if caps?.goToPage && caps.pages}
    <div class="page-controls">
      <Tooltip label={$t('viewer.previous')} position="bottom"><UiIconButton label={$t('viewer.previous')} size="xs" type="button" class={uiClass(" ", "ui-local-eaba586c")} onclick={() => caps?.goToPage?.((caps.page ?? 1) - 1)} disabled={(caps.page ?? 1) <= 1} ><ChevronLeft /></UiIconButton></Tooltip>
      <UiInput variant="inline" class={uiClass("page-number", "ui-local-eaba586c")} aria-label={$t('viewer.page', { values: { n: caps.page, total: caps.pages } })} inputmode="numeric" bind:value={pageInput} onblur={commitPage} onkeydown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitPage(); } else if (event.key === 'Escape') { event.stopPropagation(); pageInput = String(caps?.page ?? 1); event.currentTarget.blur(); } }} />
      <span class="page-total">/ {caps.pages}</span>
      <Tooltip label={$t('viewer.next')} position="bottom"><UiIconButton label={$t('viewer.next')} size="xs" type="button" class={uiClass(" ", "ui-local-eaba586c")} onclick={() => caps?.goToPage?.((caps.page ?? 1) + 1)} disabled={(caps.page ?? 1) >= caps.pages} ><ChevronRight /></UiIconButton></Tooltip>
    </div>
  {/if}
  {#if caps?.zoomBy}
    {#if !narrow}<Tooltip label={$t('viewer.zoomOut')} position="bottom"><UiIconButton label={$t('viewer.zoomOut')} size="xs" type="button" class={uiClass(" ", "ui-local-eaba586c")} onclick={() => caps?.zoomBy?.(-1)} ><Minus /></UiIconButton></Tooltip>{/if}
    <UiButton variant="ghost" size="xs" type="button" class={uiClass("zoom-label", "ui-local-eaba586c")} onclick={() => caps?.fit?.()} disabled={!caps.fit} title={$t('viewer.fit')}>{caps.zoom}</UiButton>
    {#if !narrow}<Tooltip label={$t('viewer.zoomIn')} position="bottom"><UiIconButton label={$t('viewer.zoomIn')} size="xs" type="button" class={uiClass(" ", "ui-local-eaba586c")} onclick={() => caps?.zoomBy?.(1)} ><Plus /></UiIconButton></Tooltip>{/if}
  {/if}
  {#if caps?.search}<Tooltip label={$t('artifacts.reader.search')} position="bottom"><UiIconButton label={$t('artifacts.reader.search')} size="xs" type="button" class={uiClass(" ", "ui-local-eaba586c")}  aria-expanded={controls.searchOpen} bind:ref={searchToggle} onclick={() => { controls.searchOpen = !controls.searchOpen; }}><Search /></UiIconButton></Tooltip>{/if}
  {@render beforeMenu?.()}
  <Menu label={$t('browser.more')} placement="bottom-end">
    {#snippet trigger(props)}<UiIconButton label={$t('browser.more')} size="xs" type="button" class={uiClass(" ", "ui-local-eaba586c")} {...props} ><Ellipsis /></UiIconButton>{/snippet}
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
  {#if onclose}<Tooltip label={$t('artifacts.reader.close')} position="bottom"><UiIconButton label={$t('artifacts.reader.close')} size="xs" type="button" class={uiClass(" ", "ui-local-eaba586c")} onclick={onclose} ><X /></UiIconButton></Tooltip>{/if}
</UiToolbar>
{#if controls.searchOpen && caps?.search}
  <div class="viewer-find">
    <Search class="size-3.5" />
    <UiInput class={uiClass('', "ui-local-eaba586c")} bind:ref={field} bind:value={controls.query} aria-label={$t('artifacts.reader.search')} placeholder={$t('artifacts.reader.search')} onkeydown={findKeydown} />
    <span aria-live="polite">{#if caps.search.loading}…{:else}{caps.search.matches ? caps.search.index + 1 : 0}/{caps.search.matches}{/if}</span>
    {#if caps.search.step}
      <Tooltip label={$t('viewer.previous')} position="bottom"><UiIconButton label={$t('viewer.previous')} size="xs" type="button" class={uiClass(" ", "ui-local-eaba586c")} disabled={!caps.search.matches} onclick={() => caps?.search?.step?.(-1)} ><ChevronLeft /></UiIconButton></Tooltip>
      <Tooltip label={$t('viewer.next')} position="bottom"><UiIconButton label={$t('viewer.next')} size="xs" type="button" class={uiClass(" ", "ui-local-eaba586c")} disabled={!caps.search.matches} onclick={() => caps?.search?.step?.(1)} ><ChevronRight /></UiIconButton></Tooltip>
    {/if}
    <Tooltip label={$t('artifacts.clearSearch')} position="bottom"><UiIconButton label={$t('artifacts.clearSearch')} size="xs" type="button" class={uiClass(" ", "ui-local-eaba586c")} onclick={() => { controls.query = ''; controls.searchOpen = false; }} ><X /></UiIconButton></Tooltip>
  </div>
{/if}

<style>
  :global(.viewer-toolbar.ui-local-eaba586c) { display:flex; height:max(36px,calc(var(--text-xs) * 1.5 + 12px)); min-height:36px; flex-shrink:0; min-width:0; align-items:center; gap:2px; padding:0 5px; background:var(--card); color:var(--muted-foreground); font-size:var(--text-xs); }
  .viewer-title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding:0 5px; color:var(--foreground); }
  .page-controls { display:flex; align-items:center; flex-shrink:0; gap:2px; font-variant-numeric:tabular-nums; }
  :global(.page-number.ui-local-eaba586c) { width:3ch; max-width:40px; padding:2px 0; border:0; border-radius:4px; background:transparent; color:var(--foreground); text-align:center; font:inherit; }
  :global(.page-number:focus.ui-local-eaba586c) { background:var(--muted); }
  .page-total { white-space:nowrap; font-size:var(--text-xs); }
  :global(.zoom-label.ui-local-eaba586c) { min-width:36px; padding:4px; font-size:var(--text-xs); font-variant-numeric:tabular-nums; border-radius:var(--radius-full); }
  :global(.zoom-label:hover.ui-local-eaba586c) { background:var(--surface-hover); color:var(--foreground); }
  .viewer-find { display:flex; align-items:center; flex-shrink:0; gap:4px; margin:0 5px 4px; padding:2px 5px 2px 8px; height:max(28px,calc(var(--text-xs) * 1.5 + 8px)); border-radius:var(--radius-full); background:var(--muted); color:var(--muted-foreground); font-size:var(--text-xs); }
  .viewer-find :global(input.ui-local-eaba586c) { flex:1; width:0; min-width:0; border:0; outline:0; background:transparent; font:inherit; color:var(--foreground); }
  :global(.viewer-toolbar.ui-local-eaba586c) :global(:is(button:focus-visible, :global(button:focus-visible.ui-local-eaba586c))), :global(.page-number:focus-visible.ui-local-eaba586c), .viewer-find:focus-within { outline:1px solid var(--muted-foreground); outline-offset:-1px; }
  :global(.viewer-toolbar.ui-local-eaba586c) :global(:is(button, :global(button.ui-local-eaba586c))) { flex-shrink:0; }
</style>

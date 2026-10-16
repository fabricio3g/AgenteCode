<svelte:options runes={true} />

<!--
  Layers: the open page's elements as a tree, built from its source (not the
  live frame), floating over the canvas's left edge. Hovering a row outlines
  that element in the frame; clicking one (or Enter) selects it with the
  Select tool. Keys: Up/Down move, Right opens or steps in, Left folds or
  climbs, Home/End jump, Enter selects. Toggled from the top bar and with
  Ctrl/⌘+Alt+L.
-->

<script lang="ts">
  import { untrack } from 'svelte';
  import { ChevronRight, X } from 'lucide-svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import { copy } from '$lib/copy';
  import { designStore } from './design.svelte';
  import { ancestorSelectors, buildLayerTree, layerIndexFor, layerKey, visibleRows } from './design-layers';

  const page = $derived(designStore.activeFrame?.page ?? designStore.selected);
  const source = $derived(designStore.data.files[page]);
  const tree = $derived(buildLayerTree(source));
  let overrides = $state<Record<string, boolean>>({});
  let focus = $state(0);
  let list = $state<HTMLDivElement>();

  const rows = $derived(visibleRows(tree, overrides));
  const picked = $derived(layerIndexFor(source, designStore.selection.filter((item) => item.page === page).at(-1)?.selector ?? ''));

  // A pick made in the frame opens its way down the tree and takes the focus.
  $effect(() => {
    const index = picked;
    if (index === null) return;
    untrack(() => {
      const ancestors = ancestorSelectors(tree, index);
      if (ancestors.some((selector) => overrides[selector] !== true)) overrides = { ...overrides, ...Object.fromEntries(ancestors.map((selector) => [selector, true])) };
      const at = visibleRows(tree, overrides).findIndex((row) => row.node.index === index);
      if (at >= 0) focus = at;
    });
  });

  $effect(() => { if (focus > rows.length - 1) focus = Math.max(0, rows.length - 1); });
  // Leaving the panel (or closing it) clears the outline it put on the page.
  $effect(() => () => { designStore.layerHover = ''; });

  function choose(at: number) {
    focus = at;
    designStore.pickSelector(rows[at].node.selector);
  }

  function toggle(selector: string, open: boolean) {
    overrides = { ...overrides, [selector]: open };
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const move = layerKey(rows, focus, event.key);
    if (!move) return;
    event.preventDefault();
    event.stopPropagation();
    focus = move.focus;
    if (move.toggle) toggle(move.toggle.selector, move.toggle.open);
    designStore.layerHover = rows[move.focus]?.node.selector ?? '';
    if (move.select) choose(move.focus);
    queueMicrotask(() => list?.querySelector<HTMLElement>('[data-focused="true"]')?.scrollIntoView({ block: 'nearest' }));
  }
</script>

<aside class="layers ui-float" aria-label={copy.design.layers.title} data-board-float>
  <header class="head">
    <h2>{copy.design.layers.title}</h2>
    <IconButton label={copy.design.layers.hide} size="xs" onclick={() => designStore.toggleLayers()}><X aria-hidden="true" /></IconButton>
  </header>
  {#if rows.length === 0}
    <p class="empty">{copy.design.layers.empty}</p>
  {:else}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="tree"
      role="tree"
      tabindex="0"
      aria-label={copy.design.layers.title}
      aria-activedescendant={`layer-${focus}`}
      bind:this={list}
      onkeydown={onKeydown}
      onfocus={() => (designStore.layerHover = rows[focus]?.node.selector ?? '')}
      onblur={() => (designStore.layerHover = '')}
    >
      {#each rows as row, at (row.node.selector)}
        {@const branch = row.node.children.length > 0}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
          id={`layer-${at}`}
          class="row"
          class:focused={at === focus}
          class:picked={row.node.index === picked}
          role="treeitem"
          tabindex="-1"
          aria-selected={row.node.index === picked}
          aria-expanded={branch ? row.open : undefined}
          aria-level={row.depth + 1}
          data-focused={at === focus}
          style:padding-left="{0.25 + row.depth * 0.875}rem"
          onpointerenter={() => (designStore.layerHover = row.node.selector)}
          onpointerleave={() => (designStore.layerHover = '')}
          onclick={() => choose(at)}
        >
          <span class="twist" class:open={row.open} class:leaf={!branch} onclick={(event) => { event.stopPropagation(); if (branch) toggle(row.node.selector, !row.open); }} role="presentation">
            <ChevronRight aria-hidden="true" />
          </span>
          <span class="name">{row.node.label}</span>
          {#if row.node.text}<span class="text">{row.node.text}</span>{/if}
        </div>
      {/each}
    </div>
  {/if}
</aside>

<style>
  .layers {
    display: flex;
    width: 15rem;
    max-height: 100%;
    flex-direction: column;
    padding: 0.25rem;
    overflow: hidden;
    font-size: var(--text-xs);
  }

  .head { display: flex; align-items: center; justify-content: space-between; padding: 0.125rem 0.125rem 0.125rem 0.5rem; }
  h2 { margin: 0; color: var(--muted-foreground); font-size: var(--text-xs); font-weight: 500; }

  .tree { min-height: 0; overflow-y: auto; outline: none; }

  .row {
    display: flex;
    height: 1.625rem;
    align-items: center;
    gap: 0.25rem;
    padding-right: 0.5rem;
    border-radius: var(--radius-sm);
    color: var(--foreground);
    cursor: default;
    white-space: nowrap;
  }
  .row:hover { background: color-mix(in srgb, var(--foreground) 6%, transparent); }
  .row.picked { background: color-mix(in srgb, var(--brand-accent) 14%, transparent); }
  /* The keyboard's place shows only while the tree has focus. */
  .tree:focus-visible .row.focused { box-shadow: inset 0 0 0 1.5px var(--brand-accent); }

  .twist { display: inline-flex; width: 0.875rem; flex-shrink: 0; align-items: center; justify-content: center; color: var(--muted-foreground); }
  .twist :global(svg) { width: 12px; height: 12px; transition: transform var(--motion-instant, 90ms) var(--motion-ease, ease); }
  .twist.open :global(svg) { transform: rotate(90deg); }
  .twist.leaf { visibility: hidden; }

  .name { flex-shrink: 0; font-family: var(--font-mono); }
  .text { min-width: 0; overflow: hidden; color: var(--muted-foreground); text-overflow: ellipsis; }
  .empty { margin: 0; padding: 0.5rem; color: var(--muted-foreground); }
</style>

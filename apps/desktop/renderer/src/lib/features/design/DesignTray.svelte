<svelte:options runes={true} />

<!--
  The strip under the canvas: variants to compare and promote, or the saved
  versions to restore. One tray, two lists, so neither costs the canvas more
  than one row of height.
-->

<script lang="ts">
  import { cn as uiClass } from '$lib/utils/cn';

  import { Check, X } from 'lucide-svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import { copy } from '$lib/copy';
  import { buildPreviewHtml } from '$lib/utils/preview-builder';
  import { designStore } from './design.svelte';
  import { pageLabel } from './design-view';

  /** The page every thumbnail renders at before it is scaled down. */
  const THUMB_WIDTH = 1280;
  const THUMB_SCALE = 0.17;

  function thumb(path: string): string {
    const { files } = designStore.data;
    const source = files[path];
    if (source === undefined) return '';
    // Static thumbnails: no scripts, so many of them stay cheap.
    try { return buildPreviewHtml(source, files, path, false).html; } catch { return ''; }
  }

  const entry = $derived(designStore.data.pages[0] ?? '');
  const cards = $derived([
    ...(entry ? [{ name: copy.design.variants.current, path: entry, variant: '' }] : []),
    ...designStore.data.variants.map((variant) => ({ name: variant.name, path: variant.entry, variant: variant.name }))
  ]);

  const time = (ts: number) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
</script>

{#if designStore.tray === 'variants' || designStore.tray === 'versions'}
  <section class="tray" aria-label={designStore.tray === 'variants' ? copy.design.variants.title : copy.design.versions.title}>
    <header>
      <h2>{designStore.tray === 'variants' ? copy.design.variants.title : copy.design.versions.title}</h2>
      <IconButton label={copy.design.variants.close} onclick={() => (designStore.tray = null)}><X aria-hidden="true" /></IconButton>
    </header>

    {#if designStore.tray === 'variants'}
      {#if designStore.data.variants.length === 0}
        <p class="hint"><span>{copy.design.variants.none}</span> {copy.design.variants.noneHint}</p>
      {:else}
        <ul class="cards">
          {#each cards as card (card.path)}
            <li class="card" class:active={designStore.selected === card.path}>
              <Button variant="plain" type="button" class={uiClass("preview", "ui-local-5ec5cde1")} onclick={() => designStore.select(card.path)} aria-pressed={designStore.selected === card.path} aria-label={card.name}>
                <span class="thumb" style:width="{THUMB_WIDTH * THUMB_SCALE}px" style:height="{THUMB_WIDTH * THUMB_SCALE * 0.62}px">
                  <iframe srcdoc={thumb(card.path)} sandbox="" tabindex="-1" aria-hidden="true" title="" style:width="{THUMB_WIDTH}px" style:height="{THUMB_WIDTH * 0.62}px" style:transform="scale({THUMB_SCALE})"></iframe>
                </span>
              </Button>
              <div class="meta">
                <span class="name">{card.name}</span>
                {#if card.variant}
                  <Button variant="outline" size="xs" onclick={() => designStore.promote(card.variant)}><Check aria-hidden="true" />{copy.design.variants.use}</Button>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    {:else if designStore.versions.length === 0}
      <p class="hint">{copy.design.versions.none}</p>
    {:else}
      <ul class="versions">
        {#each designStore.versions as version (version.id)}
          <li>
            <span class="v">v{version.id}</span>
            <span class="label">{version.label || (version.auto ? copy.design.versions.auto : time(version.createdAt))}</span>
            <span class="when">{time(version.createdAt)} · {version.files} {copy.design.versions.files}</span>
            <Button variant="outline" size="xs" onclick={() => designStore.restore(version.id)}>{copy.design.versions.restore}</Button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<style>
  /* The strip takes the canvas column's width; its top rule meets the column's dividers. */
  .tray {
    display: flex;
    max-height: 15rem;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.625rem 0.875rem 0.875rem;
    background: var(--background);
    box-shadow: 0 -1px 0 var(--border-subtle);
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  h2 {
    margin: 0;
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--muted-foreground);
  }

  .hint {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--muted-foreground);
  }

  .hint span { color: var(--foreground); }

  .cards {
    display: flex;
    margin: 0;
    padding: 0 0 0.25rem;
    gap: 0.875rem;
    list-style: none;
    overflow-x: auto;
  }

  .card { display: flex; flex-shrink: 0; flex-direction: column; gap: 0.375rem; }

  :global(.preview.ui-local-5ec5cde1) {
    padding: 0;
    border: 0;
    border-radius: 0.5rem;
    background: transparent;
    cursor: pointer;
  }

  .thumb {
    position: relative;
    display: block;
    overflow: hidden;
    border-radius: 0.5rem;
    background: #fff;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.08);
    transition: box-shadow var(--motion-fast) var(--motion-ease);
  }

  .card.active .thumb { box-shadow: 0 0 0 2px var(--brand-accent); }
  :global(.preview:hover.ui-local-5ec5cde1 .thumb) { box-shadow: 0 2px 10px rgb(0 0 0 / 0.14); }
  .card.active :global(.preview:hover.ui-local-5ec5cde1 .thumb) { box-shadow: 0 0 0 2px var(--brand-accent); }
  :global(.preview:focus-visible.ui-local-5ec5cde1) { outline: 2px solid var(--brand-accent); outline-offset: 2px; }

  iframe {
    position: absolute;
    inset: 0 auto auto 0;
    border: 0;
    pointer-events: none;
    transform-origin: top left;
  }

  .meta { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
  .name { font-size: var(--text-sm); color: var(--foreground); }

  .versions {
    margin: 0;
    padding: 0;
    list-style: none;
    overflow-y: auto;
  }

  .versions li {
    display: grid;
    grid-template-columns: 2.5rem minmax(0, 1fr) 9rem auto;
    align-items: center;
    gap: 0.75rem;
    padding: 0.125rem 0;
    font-size: var(--text-sm);
  }

  .v { color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
  .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .when { color: var(--muted-foreground); font-size: var(--text-xs); text-align: right; }
</style>

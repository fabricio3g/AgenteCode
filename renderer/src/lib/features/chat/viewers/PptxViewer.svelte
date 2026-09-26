<svelte:options runes={true} />

<!--
  A deck the way PowerPoint shows it: numbered slide thumbnails down the
  left, the current slide large on a gray canvas, speaker notes underneath,
  and a present mode that fills the screen (arrows, space or click to
  advance, Esc to leave). Slides are the file's own layout (see pptx-render).
-->

<script lang="ts">
  import { ChevronLeft, ChevronRight, NotebookText, Play, X } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import ViewerStatus from './ViewerStatus.svelte';
  import { renderPptx, type RenderedDeck } from './pptx-render';
  import DeckSlideView from './DeckSlideView.svelte';
  import Portal from '$lib/ui/components/Portal.svelte';
  import type { DeckSpec } from '$shared/deck';

  interface Props {
    src: string;
    filename: string;
    /**
     * The deck spec a generated .pptx was built from. When present, slides are
     * drawn from it (crisp, exact); other .pptx files are rendered from bytes.
     */
    spec?: DeckSpec | null;
  }

  let { src, filename, spec = null }: Props = $props();

  let loading = $state(true);
  let error = $state<string | null>(null);
  let deck = $state<RenderedDeck | null>(null);
  let current = $state(0);
  let showNotes = $state(true);
  let presenting = $state(false);
  let root = $state<HTMLDivElement>();
  let presenter = $state<HTMLDivElement>();
  let rail = $state<HTMLDivElement>();
  let narrow = $state(false);

  type ViewSlide = { key: string; url?: string; title: string; notes: string };
  const slides = $derived<ViewSlide[]>(
    spec
      ? spec.slides.map((item, index) => ({ key: `s${index}`, title: item.title, notes: item.notes ?? '' }))
      : (deck?.slides ?? []).map((item) => ({ key: item.url, url: item.url, title: item.title, notes: item.notes }))
  );
  const slide = $derived(slides[current] ?? null);
  const aspect = $derived(spec ? 16 / 9 : (deck?.aspect ?? 16 / 9));

  $effect(() => {
    if (spec) {
      loading = false;
      error = null;
      return;
    }
    const source = src;
    let live = true;
    let loaded: RenderedDeck | null = null;
    loading = true;
    error = null;
    deck = null;
    current = 0;
    renderPptx(source)
      .then((result) => {
        loaded = result;
        if (live) deck = result;
        else result.dispose();
      })
      .catch((err) => {
        console.error('[PptxViewer] Failed to render deck:', err);
        if (live) error = $t('viewer.slides.failed');
      })
      .finally(() => {
        if (live) loading = false;
      });
    return () => {
      live = false;
      loaded?.dispose();
    };
  });

  // Narrow panels hide the rail; the stage matters more.
  $effect(() => {
    if (!root || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => (narrow = (root?.clientWidth ?? 0) < 560));
    observer.observe(root);
    return () => observer.disconnect();
  });

  function go(index: number) {
    if (!slides.length) return;
    current = Math.max(0, Math.min(slides.length - 1, index));
    rail?.querySelector<HTMLElement>(`[data-slide="${current}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  function onKeydown(event: KeyboardEvent) {
    const next = ['ArrowRight', 'ArrowDown', 'PageDown', ' '];
    const previous = ['ArrowLeft', 'ArrowUp', 'PageUp'];
    if (next.includes(event.key)) {
      event.preventDefault();
      go(current + 1);
    } else if (previous.includes(event.key)) {
      event.preventDefault();
      go(current - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      go(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      go(slides.length - 1);
    } else if (event.key === 'Escape' && presenting) {
      event.preventDefault();
      event.stopPropagation();
      void exitPresent();
    }
  }

  async function present() {
    presenting = true;
    await Promise.resolve();
    presenter?.focus();
    try {
      await presenter?.requestFullscreen?.();
    } catch {
      /* the overlay alone still covers the window */
    }
  }

  async function exitPresent() {
    presenting = false;
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    root?.focus();
  }

  function onFullscreenChange() {
    if (!document.fullscreenElement && presenting) presenting = false;
  }
</script>

<svelte:document onfullscreenchange={onFullscreenChange} />

<!-- Arrow keys page through the deck while it has focus. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="deck" bind:this={root} tabindex="-1" role="region" aria-label={filename} onkeydown={onKeydown} style:--aspect={aspect}>
  {#if loading || error}
    <div class="deck-status"><ViewerStatus {loading} {error} label={$t('viewer.slides.loading')} variant="card" errorTitle={$t('viewer.slides.failed')} /></div>
  {:else if slide}
    <div class="deck-main">
      {#if !narrow}
        <div class="rail" bind:this={rail} role="listbox" aria-label={$t('viewer.slides.list')}>
          {#each slides as item, index (item.key)}
            <button
              type="button"
              class="thumb"
              class:on={index === current}
              data-slide={index}
              role="option"
              aria-selected={index === current}
              aria-label={item.title || $t('viewer.slides.slide', { values: { n: index + 1 } })}
              onclick={() => go(index)}
            >
              <span class="thumb-num">{index + 1}</span>
              {#if spec}
                <span class="thumb-img thumb-spec"><DeckSlideView deck={spec} slide={spec.slides[index]} {index} /></span>
              {:else}
                <img class="thumb-img" src={item.url} alt="" draggable="false" />
              {/if}
            </button>
          {/each}
        </div>
      {/if}

      <div class="stage">
        <div class="stage-fit">
          {#if spec}
            <div class="slide"><DeckSlideView deck={spec} slide={spec.slides[current]} index={current} /></div>
          {:else}
            <img class="slide" src={slide.url} alt={slide.title || $t('viewer.slides.slide', { values: { n: current + 1 } })} draggable="false" />
          {/if}
        </div>
      </div>
    </div>

    {#if showNotes}
      <div class="notes" aria-label={$t('viewer.slides.notes')}>
        {#if slide.notes}{slide.notes}{:else}<span class="notes-empty">{$t('viewer.slides.noNotes')}</span>{/if}
      </div>
    {/if}

    <div class="deck-bar">
      <div class="bar-group">
        <button type="button" class="bar-btn" onclick={() => go(current - 1)} disabled={current === 0} aria-label={$t('viewer.previous')}><ChevronLeft class="size-4" /></button>
        <span class="counter">{$t('viewer.slides.of', { values: { n: current + 1, total: slides.length } })}</span>
        <button type="button" class="bar-btn" onclick={() => go(current + 1)} disabled={current >= slides.length - 1} aria-label={$t('viewer.next')}><ChevronRight class="size-4" /></button>
      </div>
      <div class="bar-group">
        <button type="button" class="text-btn" class:on={showNotes} onclick={() => (showNotes = !showNotes)} aria-pressed={showNotes}>
          <NotebookText class="size-3.5" /> {showNotes ? $t('viewer.slides.hideNotes') : $t('viewer.slides.showNotes')}
        </button>
        <button type="button" class="text-btn" onclick={present}><Play class="size-3.5" /> {$t('viewer.slides.present')}</button>
      </div>
    </div>
  {/if}
</div>

{#if presenting && slide}
  <!-- Portaled to <body>: above every panel, menu and toast while presenting. -->
  <Portal>
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="presenter"
      bind:this={presenter}
      tabindex="-1"
      role="dialog"
      aria-modal="true"
      aria-label={$t('viewer.slides.present')}
      onkeydown={onKeydown}
      onclick={(event) => { if (!(event.target as HTMLElement).closest('button')) go(current + 1); }}
      style:--aspect={aspect}
    >
      {#if spec}
        <div class="presenter-slide"><DeckSlideView deck={spec} slide={spec.slides[current]} index={current} /></div>
      {:else}
        <img class="presenter-slide" src={slide.url} alt={slide.title} draggable="false" />
      {/if}
      <button type="button" class="presenter-exit" onclick={(event) => { event.stopPropagation(); void exitPresent(); }} aria-label={$t('viewer.slides.exit')}><X class="size-4" /></button>
      <span class="presenter-count">{current + 1} / {slides.length}</span>
    </div>
  </Portal>
{/if}

<style>
  .deck {
    --deck-canvas: color-mix(in srgb, var(--foreground) 7%, var(--background));
    display: flex;
    height: var(--doc-viewer-height, calc(96vh - 8rem));
    min-height: 18rem;
    flex: 1 1 auto;
    flex-direction: column;
    overflow: hidden;
    border: var(--doc-viewer-border, 1px solid var(--border));
    border-radius: var(--doc-viewer-radius, 0.75rem);
    background: var(--deck-canvas);
    outline: none;
  }
  .deck-status {
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;
  }
  .deck-main {
    display: flex;
    min-height: 0;
    flex: 1;
  }

  .rail {
    display: flex;
    width: 10.5rem;
    flex-shrink: 0;
    flex-direction: column;
    gap: 0.75rem;
    overflow-y: auto;
    padding: 0.875rem 0.75rem 1rem 0.5rem;
    border-right: 1px solid var(--border);
    background: var(--background);
  }
  .thumb {
    display: flex;
    align-items: flex-start;
    gap: 0.375rem;
    text-align: left;
  }
  .thumb-num {
    width: 1rem;
    padding-top: 0.125rem;
    font-size: 11px;
    text-align: right;
    color: var(--muted-foreground);
    font-variant-numeric: tabular-nums;
  }
  .thumb-img {
    min-width: 0;
    flex: 1;
    aspect-ratio: var(--aspect);
    border-radius: 3px;
    background: #fff;
    box-shadow: 0 0 0 1px var(--border);
    transition: box-shadow var(--motion-fast) var(--motion-ease);
  }
  .thumb:hover .thumb-img {
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--foreground) 30%, var(--border));
  }
  .thumb.on .thumb-img {
    box-shadow: 0 0 0 2px var(--primary);
  }
  .thumb-spec {
    display: block;
    overflow: hidden;
  }
  .thumb.on .thumb-num {
    color: var(--foreground);
    font-weight: 600;
  }

  .stage {
    display: flex;
    min-width: 0;
    flex: 1;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
    container-type: size;
  }
  /* The largest 16:9 (or the deck's ratio) box that fits the stage. */
  .stage-fit {
    width: min(100cqw, calc(100cqh * var(--aspect)));
    aspect-ratio: var(--aspect);
  }
  .slide {
    display: block;
    width: 100%;
    height: 100%;
    background: #fff;
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.14), 0 8px 24px rgb(0 0 0 / 0.1);
  }

  .notes {
    max-height: 7.5rem;
    min-height: 3.25rem;
    flex-shrink: 0;
    overflow-y: auto;
    padding: 0.625rem 1rem;
    border-top: 1px solid var(--border);
    background: var(--background);
    font-size: 13px;
    line-height: 1.5;
    white-space: pre-wrap;
    color: var(--foreground);
  }
  .notes-empty {
    color: var(--muted-foreground);
  }

  .deck-bar {
    display: flex;
    height: 2.25rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: space-between;
    padding: 0 0.5rem;
    border-top: 1px solid var(--border);
    background: var(--background);
    font-size: 12px;
    color: var(--muted-foreground);
  }
  .bar-group {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }
  .counter {
    min-width: 3.5rem;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .bar-btn {
    display: inline-flex;
    width: 1.75rem;
    height: 1.75rem;
    align-items: center;
    justify-content: center;
    border-radius: 0.375rem;
  }
  .bar-btn:hover:not(:disabled),
  .text-btn:hover {
    background: var(--surface-hover);
    color: var(--foreground);
  }
  .bar-btn:disabled {
    opacity: 0.4;
  }
  .text-btn {
    display: inline-flex;
    height: 1.75rem;
    align-items: center;
    gap: 0.375rem;
    padding: 0 0.625rem;
    border-radius: 0.375rem;
  }
  .text-btn.on {
    color: var(--foreground);
  }

  .presenter {
    position: fixed;
    inset: 0;
    z-index: calc(var(--z-toast, 900) + 100);
    display: flex;
    align-items: center;
    justify-content: center;
    background: #000;
    outline: none;
    cursor: pointer;
  }
  .presenter-slide {
    width: min(100vw, calc(100vh * var(--aspect)));
    aspect-ratio: var(--aspect);
    background: #fff;
  }
  .presenter-exit {
    position: absolute;
    top: 1rem;
    right: 1rem;
    display: inline-flex;
    width: 2.25rem;
    height: 2.25rem;
    align-items: center;
    justify-content: center;
    border-radius: 9999px;
    background: rgb(255 255 255 / 0.12);
    color: #fff;
    opacity: 0.4;
    transition: opacity 150ms ease;
  }
  .presenter:hover .presenter-exit {
    opacity: 1;
  }
  .presenter-count {
    position: absolute;
    bottom: 1rem;
    right: 1.25rem;
    font-size: 12px;
    color: rgb(255 255 255 / 0.5);
    font-variant-numeric: tabular-nums;
  }
</style>

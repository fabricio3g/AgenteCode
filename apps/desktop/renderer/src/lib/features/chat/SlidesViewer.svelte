<svelte:options runes={true} />

<script lang="ts">
  import type { SlideData } from '$lib/types/bridge';
  import { t } from 'svelte-i18n';
  import { registerViewerControls, useViewerControls } from './viewers/viewer-controls.svelte';
  const controls = useViewerControls();

  interface Props {
    slides: SlideData[];
    onDownload: () => void;
  }

  let { slides, onDownload }: Props = $props();

  let currentIndex = $state(0);

  const currentSlide = $derived(slides[currentIndex] || null);
  const total = $derived(slides.length);

  let showNotes = $state(true);
  registerViewerControls(controls, () => ({
    page: currentIndex + 1, pages: total, goToPage: page => { currentIndex = Math.max(0, Math.min(total - 1, page - 1)); },
    actions: [{ label: showNotes ? $t('viewer.slides.hideNotes') : $t('viewer.slides.showNotes'), run: () => { showNotes = !showNotes; } }, { label: $t('artifacts.card.download'), run: onDownload }]
  }));

  function prev() {
    if (currentIndex > 0) currentIndex -= 1;
  }

  function next() {
    if (currentIndex < total - 1) currentIndex += 1;
  }

  function handleKeydown(event: KeyboardEvent) {
    if ((event.target as HTMLElement).closest('input, textarea, button')) return;
    if (event.key === 'ArrowLeft') prev();
    else if (event.key === 'ArrowRight') next();
  }

  // Parse bullet points: each item in content array or newline-split string
  function getBullets(slide: SlideData): string[] {
    if (Array.isArray(slide.content)) return slide.content.filter(Boolean);
    return [];
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_no_noninteractive_tabindex -->
<div class="legacy-deck" role="region" tabindex="0" aria-label={$t('artifacts.kind.presentation')} onkeydown={handleKeydown}>
  <!-- Slide content -->
  {#if currentSlide}
    <div class="px-6 py-8">
      <h2 class="mb-5 text-2xl font-bold leading-tight text-[var(--text)]">
        {currentSlide.title}
      </h2>
      <ul class="space-y-2.5">
        {#each getBullets(currentSlide) as bullet, i (i)}
          <li class="flex items-start gap-3 text-[15px] leading-relaxed text-[var(--text-secondary)]">
            <span class="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[var(--primary)]/70"></span>
            <span>{bullet}</span>
          </li>
        {/each}
      </ul>
      {#if currentSlide.notes && showNotes}
        <div class="mt-6 rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface-hover)] px-4 py-3 text-xs text-[var(--text-secondary)]">
          <span class="font-semibold">Speaker notes: </span>{currentSlide.notes}
        </div>
      {/if}
    </div>
  {/if}

</div>
<style>
  .legacy-deck { flex:1; min-height:0; overflow:auto; background:var(--muted); color:var(--foreground); }
</style>

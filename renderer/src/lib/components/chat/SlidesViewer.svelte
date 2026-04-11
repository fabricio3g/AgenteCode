<svelte:options runes={true} />

<script lang="ts">
  import type { SlideData } from '$lib/types/tauri';
  import { ChevronLeft, ChevronRight, Download } from 'lucide-svelte';

  interface Props {
    slides: SlideData[];
    onDownload: () => void;
  }

  let { slides, onDownload }: Props = $props();

  let currentIndex = $state(0);

  const currentSlide = $derived(slides[currentIndex] || null);
  const total = $derived(slides.length);

  function prev() {
    if (currentIndex > 0) currentIndex -= 1;
  }

  function next() {
    if (currentIndex < total - 1) currentIndex += 1;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowLeft') prev();
    else if (event.key === 'ArrowRight') next();
  }

  // Parse bullet points: each item in content array or newline-split string
  function getBullets(slide: SlideData): string[] {
    if (Array.isArray(slide.content)) return slide.content.filter(Boolean);
    return [];
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="mt-4 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-sm">
  <!-- Header bar -->
  <div class="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
    <span class="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
      Presentation · {total} slide{total === 1 ? '' : 's'}
    </span>
    <button
      class="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3 py-1.5 text-xs font-semibold text-[var(--primary-fg)] transition hover:opacity-88 active:scale-[0.98]"
      onclick={onDownload}
    >
      <Download class="h-3.5 w-3.5" />
      Download PPTX
    </button>
  </div>

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
      {#if currentSlide.notes}
        <div class="mt-6 rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface-highlight)] px-4 py-3 text-xs text-[var(--text-secondary)]">
          <span class="font-semibold">Speaker notes: </span>{currentSlide.notes}
        </div>
      {/if}
    </div>
  {/if}

  <!-- Navigation footer -->
  <div class="flex items-center justify-between border-t border-[var(--border)] px-4 py-3">
    <button
      class="flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-highlight)] disabled:opacity-30"
      onclick={prev}
      disabled={currentIndex === 0}
      aria-label="Previous slide"
    >
      <ChevronLeft class="h-4 w-4" />
      Prev
    </button>

    <span class="text-sm font-medium tabular-nums text-[var(--text-secondary)]">
      {currentIndex + 1} / {total}
    </span>

    <button
      class="flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-highlight)] disabled:opacity-30"
      onclick={next}
      disabled={currentIndex === total - 1}
      aria-label="Next slide"
    >
      Next
      <ChevronRight class="h-4 w-4" />
    </button>
  </div>
</div>

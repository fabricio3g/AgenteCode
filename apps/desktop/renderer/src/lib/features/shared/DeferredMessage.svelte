<svelte:options runes={true} />
<script lang="ts">
  import { onMount, untrack, type Snippet } from 'svelte';
  let { immediate = false, content = '', children }: { immediate?: boolean; content?: string; children: Snippet } = $props();
  let ready = $state(untrack(() => immediate));
  let element: HTMLDivElement;
  // Preserve a useful scroll range before markdown mounts. Once revealed,
  // retain the real DOM, including selection, disclosures and measured height.
  // The two constants track the reading column: prose fills it at
  // --text-prose, whose line box is 1.7.
  const estimatedHeight = $derived(Math.min(2400, Math.max(120, Math.ceil(content.length / 88) * 26)));
  $effect(() => { if (immediate) ready = true; });
  onMount(() => {
    if (ready) return;
    if (typeof IntersectionObserver === 'undefined') { ready = true; return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { ready = true; observer.disconnect(); }
    }, { rootMargin: '400px' });
    observer.observe(element);
    return () => observer.disconnect();
  });
</script>
<div bind:this={element} aria-busy={!ready} style:min-height={ready ? undefined : `${estimatedHeight}px`}>
  {#if ready}{@render children()}{/if}
</div>

<svelte:options runes={true} />

<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { Snippet } from 'svelte';

  let {
    children,
    class: className = '',
  }: {
    children?: Snippet;
    class?: string;
  } = $props();

  let host: HTMLDivElement;
  let mounted = $state(false);

  onMount(() => {
    if (!host || typeof document === 'undefined') return;
    document.body.appendChild(host);
    mounted = true;
  });

  onDestroy(() => {
    host?.remove();
  });
</script>

<div bind:this={host} class={className}>
  {#if mounted}
    {@render children?.()}
  {/if}
</div>

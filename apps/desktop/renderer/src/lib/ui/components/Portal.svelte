<svelte:options runes={true} />

<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { Snippet } from 'svelte';

  interface Props {
    id?: string;
    className?: string;
    children?: Snippet;
  }

  let { id = undefined, className = '', children }: Props = $props();
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

<div bind:this={host} {id} class={className}>
  {#if mounted}
    {@render children?.()}
  {/if}
</div>

<svelte:options runes={true} />

<!-- A shelf with nothing on it (or no search matches): a quiet note and, when there is one, the way forward. -->

<script lang="ts">
  import { Button } from '$lib/components/ui';
  let { title, hint = '', action = '', onaction }: { title: string; hint?: string; action?: string; onaction?: () => void } = $props();
</script>

<div class="lib-empty">
  <p>{title}</p>
  {#if hint}<span>{hint}</span>{/if}
  {#if action && onaction}<Button variant="outline" size="sm" type="button" onclick={onaction}>{action}</Button>{/if}
</div>

<style>
  .lib-empty {
    display: flex;
    flex-direction: column;
    flex:1;
    justify-content:center;
    align-items: center;
    gap: 0.375rem;
    padding: 3.5rem 1rem;
    color: var(--muted-foreground);
    font-size: var(--text-sm);
    text-align: center;
  }
  .lib-empty p {
    color: var(--foreground);
    font-size: var(--text-base);
    font-weight: 500;
  }
</style>

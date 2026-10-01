<svelte:options runes={true} />

<!-- A shelf with nothing on it (or no search matches): a quiet note and, when there is one, the way forward. -->

<script lang="ts">
  let { title, hint = '', action = '', onaction }: { title: string; hint?: string; action?: string; onaction?: () => void } = $props();
</script>

<div class="lib-empty">
  <p>{title}</p>
  {#if hint}<span>{hint}</span>{/if}
  {#if action && onaction}<button type="button" class="ui-chip" onclick={onaction}>{action}</button>{/if}
</div>

<style>
  .lib-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.375rem;
    padding: 3.5rem 1rem;
    color: var(--muted-foreground);
    font-size: 12.5px;
    text-align: center;
  }
  .lib-empty p {
    color: var(--foreground);
    font-size: 14px;
    font-weight: 500;
  }
  .lib-empty .ui-chip {
    margin-top: 0.5rem;
  }
</style>

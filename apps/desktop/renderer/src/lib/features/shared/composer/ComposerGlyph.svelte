<svelte:options runes={true} />

<script lang="ts">
  let { name }: { name: 'add' | 'more' | 'mic' | 'send' | 'stop' } = $props();
</script>

<svg class="composer-glyph" viewBox="0 0 16 16" fill="none" aria-hidden="true">
  {#if name === 'add'}
    <path d="M8 3.5v9M3.5 8h9" />
  {:else if name === 'more'}
    <circle cx="3.5" cy="8" r=".85" fill="currentColor" stroke="none" />
    <circle cx="8" cy="8" r=".85" fill="currentColor" stroke="none" />
    <circle cx="12.5" cy="8" r=".85" fill="currentColor" stroke="none" />
  {:else if name === 'mic'}
    <rect x="5.5" y="2" width="5" height="8" rx="2.5" />
    <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2M6 14h4" />
  {:else if name === 'send'}
    <path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7" />
  {:else}
    <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" stroke="none" />
  {/if}
</svg>

<style>
  .composer-glyph { width: 16px; height: 16px; flex: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
</style>

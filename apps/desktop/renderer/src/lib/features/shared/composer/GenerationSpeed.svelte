<script lang="ts">
  import { t, locale } from 'svelte-i18n';
  let { value }: { value?: number } = $props();
  const valid = $derived(typeof value === 'number' && Number.isFinite(value) && value > 0);
  const number = $derived(value != null && value < 0.1 ? '<0.1'
    : new Intl.NumberFormat($locale || 'en', { maximumFractionDigits: value != null && value < 1 ? 1 : 0 }).format(value ?? 0));
</script>

{#if valid}
  <!-- `speedReply`, not `speed`: this is what one reply streamed at, observed
       here. How fast a served model can write is the provider's business — the
       queue, the batch, the network and the account's limit all sit in it. -->
  <span class="generation-speed" title={$t('runtime.speedReply')} aria-label={`${$t('runtime.speedReply')}: ${number} tok/s`}>
    {number} tok/s
  </span>
{/if}

<style>
  .generation-speed { color:var(--muted-foreground); font-size:var(--text-xs); font-variant-numeric:tabular-nums; white-space:nowrap; }
</style>

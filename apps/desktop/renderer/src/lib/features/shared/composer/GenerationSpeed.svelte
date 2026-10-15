<script lang="ts">
  import { t, locale } from 'svelte-i18n';
  let { value }: { value?: number } = $props();
  const valid = $derived(typeof value === 'number' && Number.isFinite(value) && value > 0);
  const number = $derived(new Intl.NumberFormat($locale || 'en', { maximumFractionDigits: 1 }).format(value ?? 0));
</script>

{#if valid}
  <span class="generation-speed" title={$t('runtime.speed')} aria-label={`${$t('runtime.speed')}: ${number} tok/s`}>
    {value! < 0.1 ? '<0.1' : number} tok/s
  </span>
{/if}

<style>
  .generation-speed { color:var(--muted-foreground); font-size:var(--text-xs); font-variant-numeric:tabular-nums; white-space:nowrap; }
</style>

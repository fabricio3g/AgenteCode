<svelte:options runes={true} />
<script lang="ts">
  import { t } from 'svelte-i18n';
  import type { CodeSpend } from '$shared/agente-protocol';
  import { spendCostLabel } from '$lib/features/code/accounting';

  let { spend }: { spend: CodeSpend } = $props();
  const tokens = $derived(spend.promptTokens + spend.cacheReadTokens + spend.cacheWriteTokens);
  // The one formatter, shared with the composer row, the subagent cards and the
  // TUI. A second rendering of the same number is how the ring came to print
  // `$0.000` where the composer said `free`.
  const cost = $derived(spendCostLabel(spend));
</script>

{#if cost}
  <div>{$t(spend.estimated ? 'chat.context.estimatedSpend' : 'chat.context.spend', { values: { cost } })}</div>
{/if}
{#if spend.unpriced}<div>{$t('chat.context.unpriced')}</div>{/if}
{#if spend.cacheReadTokens > 0 && tokens > 0}
  <div>{$t('chat.context.cached', { values: { percent: Math.floor(spend.cacheReadTokens * 100 / tokens) } })}</div>
{/if}

<svelte:options runes={true} />
<script lang="ts">
  import { t } from 'svelte-i18n';
  import type { CodeSpend } from '$shared/agente-protocol';

  let { spend }: { spend: CodeSpend } = $props();
  const tokens = $derived(spend.promptTokens + spend.cacheReadTokens + spend.cacheWriteTokens);
  const cost = $derived(spend.costUsd < 0.001 && spend.costUsd > 0 ? '<$0.001' : `$${spend.costUsd.toFixed(3)}`);
</script>

{#if spend.costUsd > 0 || (!spend.unpriced && tokens > 0)}
  <div>{$t(spend.estimated ? 'chat.context.estimatedSpend' : 'chat.context.spend', { values: { cost } })}{spend.unpriced ? '+' : ''}</div>
{/if}
{#if spend.unpriced}<div>{$t('chat.context.unpriced')}</div>{/if}
{#if spend.cacheReadTokens > 0 && tokens > 0}
  <div>{$t('chat.context.cached', { values: { percent: Math.floor(spend.cacheReadTokens * 100 / tokens) } })}</div>
{/if}

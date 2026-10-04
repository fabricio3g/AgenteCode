<svelte:options runes={true} />
<script lang="ts">
  import { t } from 'svelte-i18n';
  import { ChevronRight } from 'lucide-svelte';
  import { copy } from '$lib/copy';
  import type { ChatMessage } from '$lib/types/chat';
  let { report }: { report: NonNullable<NonNullable<ChatMessage['metadata']>['codeCompaction']> } = $props();
  const label = $derived(report.running ? copy.codeRun.compacting : report.success
    ? report.tokensBefore !== undefined && report.tokensBefore === report.tokensAfter ? $t('code.compaction.unchanged') : copy.codeRun.compacted
    : $t('code.compaction.failed'));
  const hasCounts = $derived(report.tokensBefore !== undefined && report.tokensAfter !== undefined);
</script>

<details class="compaction" data-compaction-report>
  <summary>
    <ChevronRight class="chevron size-3" />
    <span role="status">{label}</span>
    {#if hasCounts}<span class="counts">~{report.tokensBefore!.toLocaleString()} → ~{report.tokensAfter!.toLocaleString()} {$t('code.compaction.tokens')}</span>{/if}
  </summary>
  <div class="report-body">
    {#if !report.running && report.success}
      <div>{report.smart ? $t('code.compaction.summarized') : report.requestedSmart ? $t('code.compaction.fallback') : $t('code.compaction.noModelCall')}</div>
      {#if report.requestedSmart || report.smart}<div>{report.modelTokens !== undefined ? $t('code.compaction.spent', { values: { n: report.modelTokens.toLocaleString() } }) : $t('code.compaction.unreported')}</div>{/if}
      {#if report.cacheReadTokens}<div>{$t('code.compaction.cached', { values: { n: report.cacheReadTokens.toLocaleString() } })}</div>{/if}
    {/if}
    {#if report.error}<div>{report.error}</div>{/if}
  </div>
</details>

<style>
  .compaction { color: var(--muted-foreground); font-size: var(--text-xs); }
  summary { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; list-style: none; cursor: pointer; padding: .375rem 0; }
  summary::-webkit-details-marker { display: none; }
  summary:hover, summary:focus-visible { color: var(--foreground); }
  .counts { margin-left: auto; font-variant-numeric: tabular-nums; }
  .report-body { margin: .375rem 0 .5rem 1rem; display: grid; gap: .375rem; }
  details[open] :global(.chevron) { transform: rotate(90deg); }
</style>

<svelte:options runes={true} />
<script lang="ts">
  import { t, locale } from 'svelte-i18n';
  import type { CodeSpend } from '$shared/agente-protocol';
  import ComposerCard from '$lib/features/shared/composer/ComposerCard.svelte';
  import ComposerStatus from '$lib/features/shared/composer/ComposerStatus.svelte';

  let { usedTokens, maxTokens, remaining, usagePercent, reservedTokens = 0, estimated = false,
    promptCostPerMillionUsd, completionCostPerMillionUsd, estimatedInputCostUsd, spend, showLabel = false }: {
    estimated?: boolean;
    showLabel?: boolean;
    usedTokens: number;
    maxTokens: number;
    remaining?: number;
    usagePercent?: number;
    reservedTokens?: number;
    promptCostPerMillionUsd?: number;
    completionCostPerMillionUsd?: number;
    estimatedInputCostUsd?: number;
    spend?: CodeSpend;
  } = $props();
  let anchor = $state<HTMLButtonElement>();
  let open = $state(false);
  const id = $props.id();
  const max = $derived(Number.isFinite(maxTokens) ? Math.max(1, Math.floor(maxTokens)) : 1);
  const used = $derived(Number.isFinite(usedTokens) ? Math.max(0, Math.floor(usedTokens)) : 0);
  const percent = $derived(Math.max(0, Math.min(100, (Number.isFinite(usagePercent) ? usagePercent! : used / max * 100))));
  const percentLabel = $derived(percent > 0 && percent < 1 ? '<1' : Math.floor(percent).toString());
  const color = $derived(percent >= 95 ? 'var(--destructive)' : percent >= 80 ? 'var(--warning)' : 'var(--work-accent)');
  const circumference = 2 * Math.PI * 5.75;
  const label = $derived((estimated ? '~' : '') + $t('chat.context.usage', { values: { used: count(used), max: count(max), percent: percentLabel } }));
  function count(value: number) { return new Intl.NumberFormat($locale || 'en').format(Math.floor(value)); }
  function usd(value: number) { return value.toFixed(value >= 1 ? 2 : value >= 0.01 ? 4 : 6); }
</script>

<button bind:this={anchor} type="button" class="ui-icon-button context-ring" class:has-label={showLabel} aria-label={label}
  aria-describedby={open ? id : undefined}
  onmouseenter={() => (open = true)} onmouseleave={() => (open = false)}
  onfocus={() => (open = true)} onblur={() => (open = false)} onclick={() => (open = true)}>
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <circle class="track" cx="7" cy="7" r="5.75" stroke-width="2.5"></circle>
    <circle class="progress" cx="7" cy="7" r="5.75" stroke-width="2.5"
      style:stroke={color} style:stroke-dasharray={circumference}
      style:stroke-dashoffset={circumference * (1 - percent / 100)}></circle>
  </svg>
  {#if showLabel}<span class="context-usage-label">{estimated ? '~' : ''}{percentLabel}%</span>{/if}
</button>
{#if open}
  <ComposerCard {anchor} {id} label={label} tooltip placement="top-end" onclose={() => (open = false)}>
    <div>{label}</div>
    <div>{$t('chat.context.remaining', { values: { n: count(Math.max(0, remaining ?? max - used)) } })}</div>
    {#if reservedTokens > 0}<div>{$t('chat.context.reserved', { values: { n: count(reservedTokens) } })}</div>{/if}
    {#if promptCostPerMillionUsd != null}<div>{$t('chat.context.priceIn', { values: { price: usd(promptCostPerMillionUsd) } })}</div>{/if}
    {#if completionCostPerMillionUsd != null}<div>{$t('chat.context.priceOut', { values: { price: usd(completionCostPerMillionUsd) } })}</div>{/if}
    {#if estimatedInputCostUsd != null}<div>{$t('chat.context.estimate', { values: { cost: usd(estimatedInputCostUsd) } })}</div>{/if}
    {#if spend}<ComposerStatus {spend} />{/if}
  </ComposerCard>
{/if}

<style>
  .context-ring { flex-shrink: 0; }
  .context-ring.has-label { width:auto;gap:0.375rem;padding-inline:0.25rem;border:0;box-shadow:none;background:transparent; }
  .context-usage-label { font-size:var(--text-xs);color:var(--muted-foreground);white-space:nowrap; }
  .context-ring:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
  .track { fill: none; stroke: color-mix(in srgb, var(--muted-foreground) 20%, transparent); }
  .progress { fill: none; stroke-linecap: round; transform: rotate(-90deg); transform-origin: center; transition: stroke-dashoffset 140ms ease, stroke 140ms ease; }
  @media (prefers-reduced-motion: reduce) { .progress { transition: none; } }
</style>

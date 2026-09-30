<svelte:options runes={true} />

<script lang="ts">
  import { t } from 'svelte-i18n';
  interface Props {
    usedTokens: number;
    maxTokens: number;
    reservedTokens?: number;
    promptCostPerMillionUsd?: number;
    completionCostPerMillionUsd?: number;
    estimatedInputCostUsd?: number;
    size?: number;
    strokeWidth?: number;
  }

  let {
    usedTokens,
    maxTokens,
    reservedTokens = 0,
    promptCostPerMillionUsd,
    completionCostPerMillionUsd,
    estimatedInputCostUsd,
    size = 14,
    strokeWidth = 2.5
  }: Props = $props();
  let hover = $state(false);

  const safeMax = $derived.by(() => {
    const value = Number(maxTokens);
    if (!Number.isFinite(value) || value <= 0) return 1;
    return Math.floor(value);
  });

  const safeUsed = $derived.by(() => {
    const value = Number(usedTokens);
    if (!Number.isFinite(value) || value < 0) return 0;
    return Math.floor(value);
  });

  const usagePercent = $derived.by(() => {
    if (!safeMax) return 0;
    return Math.min(100, Math.round((safeUsed / safeMax) * 100));
  });

  const radius = $derived.by(() => (size - strokeWidth) / 2);
  const circumference = $derived.by(() => 2 * Math.PI * radius);
  const dashOffset = $derived.by(() => circumference * (1 - usagePercent / 100));

  // A gauge, not a spinner: the percentage sits beside it, and it warms as the context fills.
  const accentColor = $derived(usagePercent >= 95 ? 'var(--error)' : usagePercent >= 80 ? 'var(--warning)' : 'var(--muted-foreground)');

  const usageLabel = $derived.by(() => $t('chat.context.usage', { values: { used: formatTokenCount(safeUsed), max: formatTokenCount(safeMax), percent: usagePercent } }));
  const reserveLabel = $derived.by(() => reservedTokens > 0 ? $t('chat.context.reserved', { values: { n: formatTokenCount(reservedTokens) } }) : '');
  const pricingLabel = $derived.by(() => {
    const parts: string[] = [];
    if (promptCostPerMillionUsd && promptCostPerMillionUsd > 0) {
      parts.push($t('chat.context.priceIn', { values: { price: formatUsd(promptCostPerMillionUsd) } }));
    }
    if (completionCostPerMillionUsd && completionCostPerMillionUsd > 0) {
      parts.push($t('chat.context.priceOut', { values: { price: formatUsd(completionCostPerMillionUsd) } }));
    }
    return parts.join(' · ');
  });
  const estimatedCostLabel = $derived.by(() => {
    if (!estimatedInputCostUsd || estimatedInputCostUsd <= 0) return '';
    return $t('chat.context.estimate', { values: { cost: formatUsd(estimatedInputCostUsd) } });
  });

  function formatTokenCount(value: number) {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
    return String(value);
  }

  function formatUsd(value: number) {
    if (value >= 1) return value.toFixed(2);
    if (value >= 0.01) return value.toFixed(4);
    return value.toFixed(6);
  }
</script>

<div
  class="context-ring"
  role="img"
  aria-label={usageLabel}
  onmouseenter={() => (hover = true)}
  onmouseleave={() => (hover = false)}
>
  <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
    <circle
      class="context-ring-track"
      cx={size / 2}
      cy={size / 2}
      r={radius}
      stroke-width={strokeWidth}
    ></circle>
    <circle
      class="context-ring-progress"
      cx={size / 2}
      cy={size / 2}
      r={radius}
      stroke-width={strokeWidth}
      style={`stroke:${accentColor};stroke-dasharray:${circumference};stroke-dashoffset:${dashOffset};`}
    ></circle>
  </svg>
  <span class="context-ring-label">{usagePercent === 0 && safeUsed > 0 ? '<1' : usagePercent}%</span>

  {#if hover}
    <div class="context-tooltip">
      <div>{usageLabel}</div>
      {#if reserveLabel}<div>{reserveLabel}</div>{/if}
      {#if pricingLabel}<div>{pricingLabel}</div>{/if}
      {#if estimatedCostLabel}<div>{estimatedCostLabel}</div>{/if}
    </div>
  {/if}
</div>

<style>
  .context-ring {
    display: inline-flex;
    height: 2rem;
    position: relative;
    align-items: center;
    justify-content: center;
    gap: 0.3rem;
    padding-inline: 0.25rem;
  }

  .context-ring-label {
    color: var(--muted-foreground);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  .context-ring-track {
    fill: none;
    stroke: color-mix(in srgb, var(--text-muted) 36%, transparent);
  }

  .context-ring-progress {
    fill: none;
    stroke-linecap: round;
    transform: rotate(-90deg);
    transform-origin: center;
    transition: stroke-dashoffset 140ms ease, stroke 140ms ease;
  }

  .context-tooltip {
    position: absolute;
    right: 0;
    bottom: calc(100% + 8px);
    display: grid;
    gap: 2px;
    white-space: nowrap;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text-secondary);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-sm);
    padding: 6px 8px;
    font-size: 11px;
    line-height: 1.35;
    z-index: 60;
    pointer-events: none;
  }
</style>

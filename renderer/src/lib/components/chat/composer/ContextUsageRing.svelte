<svelte:options runes={true} />

<script lang="ts">
  interface Props {
    usedTokens: number;
    maxTokens: number;
    size?: number;
    strokeWidth?: number;
  }

  let { usedTokens, maxTokens, size = 18, strokeWidth = 2 }: Props = $props();

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

  const strokeColor = $derived.by(() => {
    if (usagePercent >= 85) return 'var(--error)';
    if (usagePercent >= 60) return 'var(--warning)';
    return 'var(--success)';
  });

  const usageLabel = $derived.by(() => `${formatTokenCount(safeUsed)} / ${formatTokenCount(safeMax)} tokens (${usagePercent}%)`);

  function formatTokenCount(value: number) {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
    return String(value);
  }
</script>

<div
  class="context-ring"
  role="img"
  aria-label={usageLabel}
  title={usageLabel}
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
      style={`stroke:${strokeColor};stroke-dasharray:${circumference};stroke-dashoffset:${dashOffset};`}
    ></circle>
  </svg>
</div>

<style>
  .context-ring {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
  }

  .context-ring-track {
    fill: none;
    stroke: var(--border-light);
  }

  .context-ring-progress {
    fill: none;
    stroke-linecap: round;
    transform: rotate(-90deg);
    transform-origin: center;
    transition: stroke-dashoffset 140ms ease, stroke 140ms ease;
  }
</style>

<svelte:options runes={true} />

<!--
  Interactive labeled hotspot diagram for biology, anatomy, hardware,
  architecture, or geography: click any pin or chip to inspect its role.
-->

<script lang="ts">
  import Button from '$lib/components/ui/Button.svelte';

  export interface HotspotPin {
    id: string;
    label: string;
    role?: string;
    description: string;
    x: number;
    y: number;
  }

  interface Props {
    pins: HotspotPin[];
  }

  let { pins }: Props = $props();
  let activeId = $state('');

  $effect(() => {
    if (!pins.some((p) => p.id === activeId)) activeId = pins[0]?.id ?? '';
  });

  const active = $derived(pins.find((p) => p.id === activeId) ?? pins[0]);
</script>

<div class="hotspot">
  <div class="hs-pills">
    {#each pins as pin (pin.id)}
      <Button
        variant="plain"
        class={`hs-pill${pin.id === activeId ? ' is-on' : ''}`}
        onclick={() => (activeId = pin.id)}
      >
        {pin.label}
      </Button>
    {/each}
  </div>

  <div class="hs-grid">
    <div class="hs-stage">
      <svg class="hs-svg" viewBox="0 0 320 200" role="img" aria-label="Interactive hotspot diagram">
        <rect x="16" y="16" width="288" height="168" rx="14" class="hs-frame" />
        {#each pins as pin, idx (pin.id)}
          {#if idx > 0}
            {@const prev = pins[idx - 1]}
            <line
              x1={24 + (prev.x / 100) * 272}
              y1={24 + (prev.y / 100) * 152}
              x2={24 + (pin.x / 100) * 272}
              y2={24 + (pin.y / 100) * 152}
              class="hs-link"
            />
          {/if}
        {/each}
        {#each pins as pin (pin.id)}
          {@const cx = 24 + (pin.x / 100) * 272}
          {@const cy = 24 + (pin.y / 100) * 152}
          {@const on = pin.id === activeId}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <g class="hs-pin" onclick={() => (activeId = pin.id)}>
            <circle {cx} {cy} r={on ? 13 : 8} class="hs-halo" class:is-on={on} />
            <circle {cx} {cy} r={on ? 5.5 : 4} class="hs-dot" class:is-on={on} />
            <text x={cx} y={cy + 16} text-anchor="middle" class="hs-txt" class:is-on={on}>{pin.label}</text>
          </g>
        {/each}
      </svg>
    </div>

    {#if active}
      <div class="hs-detail">
        {#if active.role}<span class="hs-role">{active.role}</span>{/if}
        <h4 class="hs-name">{active.label}</h4>
        <p class="hs-desc">{active.description}</p>
      </div>
    {/if}
  </div>
</div>

<style>
  .hotspot { display: flex; flex-direction: column; gap: 0.625rem; }
  .hs-pills { display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .hotspot :global(.hs-pill) {
    height: 1.7rem; padding: 0 0.65rem; border-radius: 999px;
    border: 1px solid var(--border-subtle); background: transparent;
    color: var(--text-secondary); font-size: var(--text-xs); font-weight: 500; cursor: pointer;
  }
  .hotspot :global(.hs-pill.is-on) { background: var(--surface-hover); border-color: var(--border); color: var(--foreground); }

  .hs-grid { display: grid; grid-template-columns: 1.25fr 1fr; gap: 0.75rem; align-items: stretch; }
  @media (max-width: 520px) { .hs-grid { grid-template-columns: 1fr; } }

  .hs-stage { border-radius: var(--radius-md); background: color-mix(in srgb, var(--foreground) 3%, transparent); padding: 0.35rem; }
  .hs-svg { display: block; width: 100%; height: auto; }
  .hs-frame { fill: none; stroke: var(--border-subtle); stroke-dasharray: 3 3; }
  .hs-link { stroke: var(--border-subtle); stroke-width: 1; }
  .hs-pin { cursor: pointer; }
  .hs-halo { fill: var(--muted-foreground); opacity: 0.14; }
  .hs-halo.is-on { fill: var(--brand-accent, var(--foreground)); opacity: 0.22; }
  .hs-dot { fill: var(--muted-foreground); stroke: var(--background); stroke-width: 2; }
  .hs-dot.is-on { fill: var(--brand-accent, var(--foreground)); }
  .hs-txt { fill: var(--muted-foreground); font-size: 9.5px; }
  .hs-txt.is-on { fill: var(--foreground); font-weight: 600; }

  .hs-detail {
    display: flex; flex-direction: column; justify-content: center; gap: 0.3rem;
    padding: 0.75rem; border-radius: var(--radius-md); background: color-mix(in srgb, var(--foreground) 3%, transparent);
  }
  .hs-role { font-family: var(--font-mono); font-size: 11px; color: var(--brand-accent, var(--muted-foreground)); }
  .hs-name { margin: 0; font-size: var(--text-sm); font-weight: 600; color: var(--foreground); }
  .hs-desc { margin: 0; font-size: var(--text-xs); color: var(--text-secondary); line-height: 1.55; }
</style>

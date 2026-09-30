<svelte:options runes={true} />

<!--
  How hard the model thinks. The trigger is a tiny effort meter and the
  level's name; it opens a card with a slider over the levels this model
  supports, coloured from cool (quick) to warm (deep), and one line on what
  the level means.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import ComposerCard from '$lib/features/shared/composer/ComposerCard.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import type { ReasoningLevel } from '$lib/types/chat';
  import { normalizeThinkingMode } from '$lib/stores/app-store-local-model';
  import { Brain, BrainCircuit, Gauge, Rabbit, Sparkles, Snail } from 'lucide-svelte';
  import { effortBars, effortColor } from './reasoning-effort';

  let open = $state(false);
  let anchor = $state<HTMLButtonElement>();
  const id = $props.id();
  const capabilities = $derived(appStore.reasoningCapabilities);
  const visible = $derived(capabilities.supported && capabilities.source !== 'unknown' && capabilities.levels.length > 1);
  const modelDefault = $derived(appStore.backendMode === 'local'
    ? normalizeThinkingMode(appStore.config.llm?.local?.thinking_mode, appStore.config.llm?.local?.disable_thinking)
    : 'auto');
  const levels = $derived<Array<ReasoningLevel | null>>([null, ...capabilities.levels]);
  const current = $derived(levels.includes(appStore.reasoningLevel) ? appStore.reasoningLevel : null);
  const index = $derived(levels.indexOf(current));
  const fraction = $derived(levels.length > 1 ? Math.max(0, index) / (levels.length - 1) : 1);
  /** Cool for quick answers, warm for deep thinking; Auto stays neutral. */
  const levelColor = $derived(current === null ? 'var(--muted-foreground)' : effortColor(fraction));

  /** A small character per level: quick is a rabbit, deep is a brain. */
  function iconFor(level: ReasoningLevel | null) {
    const bars = effortBars(level);
    if (level === null) return Sparkles;
    if (bars === 0) return Snail;
    if (bars === 1) return Rabbit;
    if (bars === 2) return Gauge;
    if (bars === 3) return Brain;
    return BrainCircuit;
  }

  function labelFor(level: ReasoningLevel | null): string {
    if (level !== null) return $t(`composer.thinking.level.${level}`);
    return modelDefault === 'auto'
      ? $t('composer.thinking.level.auto')
      : $t('composer.thinking.modelDefault', { values: { level: $t(`composer.thinking.level.${modelDefault}`) } });
  }

  function hintFor(level: ReasoningLevel | null): string {
    return $t(`composer.thinking.hint.${level ?? 'auto'}`, { default: '' });
  }
</script>

{#snippet meter(level: ReasoningLevel | null)}
  {@const filled = effortBars(level)}
  <span class="meter" class:is-auto={level === null} aria-hidden="true">
    {#each [1, 2, 3, 4] as bar (bar)}<span class:is-on={bar <= filled}></span>{/each}
  </span>
{/snippet}

{#if visible}
  <button bind:this={anchor} type="button" class="thinking-trigger" class:is-open={open}
    aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
    aria-label={$t('composer.thinking.trigger', { values: { level: labelFor(current) } })} title={$t('composer.thinking.title')}
    onclick={() => (open = !open)}>
    <span class="trigger-meter" style:--level={levelColor}>{@render meter(current)}</span>
    <span>{labelFor(current)}</span>
  </button>
  {#if open}
    <ComposerCard {anchor} {id} label={$t('composer.thinking.title')} onclose={() => (open = false)}>
      <div class="effort" style:--pct={`${fraction * 100}%`} style:--level={levelColor}>
        <div class="effort-head">
          {#key current}
            {@const Icon = iconFor(current)}
            <span class="effort-icon"><Icon class="size-4" /></span>
          {/key}
          <span class="effort-text">
            <span class="effort-name">{labelFor(current)}</span>
            <span class="effort-hint">{hintFor(current)}</span>
          </span>
        </div>
        <div class="effort-slider">
          <div class="stops" aria-hidden="true">
            {#each levels as level, step (level)}<span class:is-on={step <= index}></span>{/each}
          </div>
          <input type="range" min="0" max={levels.length - 1} step="1" value={index}
            aria-label={$t('composer.thinking.title')} aria-valuetext={labelFor(current)}
            oninput={(event) => appStore.setReasoningLevel(levels[Number(event.currentTarget.value)])} />
        </div>
        <div class="effort-ends" aria-hidden="true">
          <span>{labelFor(levels[0])}</span>
          <span>{labelFor(levels[levels.length - 1])}</span>
        </div>
      </div>
    </ComposerCard>
  {/if}
{/if}

<style>
  .thinking-trigger {
    display: inline-flex;
    height: 26px;
    flex-shrink: 0;
    align-items: center;
    gap: 0.375rem;
    padding: 0 0.5rem;
    border-radius: var(--radius-full);
    color: var(--muted-foreground);
    font-size: 12px;
    white-space: nowrap;
  }

  .thinking-trigger:hover,
  .thinking-trigger.is-open {
    background: var(--surface-hover);
    color: var(--foreground);
  }

  .thinking-trigger:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }

  /* Four rising bars, filled to the level: reads as "effort" at a glance. */
  .meter {
    display: inline-flex;
    height: 10px;
    flex-shrink: 0;
    align-items: flex-end;
    gap: 1.5px;
  }

  .meter span {
    width: 2.5px;
    border-radius: 1px;
    background: currentColor;
    opacity: 0.25;
  }

  .meter span:nth-child(1) { height: 4px; }
  .meter span:nth-child(2) { height: 6px; }
  .meter span:nth-child(3) { height: 8px; }
  .meter span:nth-child(4) { height: 10px; }
  .meter span.is-on { opacity: 1; }
  .meter.is-auto span { opacity: 0.5; }

  .effort { display: grid; width: 15rem; gap: 0.625rem; }
  .effort-head { display: flex; align-items: flex-start; gap: 0.625rem; min-height: 2.4rem; }
  .effort-text { display: grid; gap: 0.125rem; min-width: 0; }
  .effort-icon {
    display: inline-flex;
    width: 1.75rem;
    height: 1.75rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border-radius: 0.5rem;
    background: color-mix(in srgb, var(--level) 16%, transparent);
    color: var(--level);
    animation: effort-pop 260ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  @keyframes effort-pop {
    from { transform: scale(0.6) rotate(-12deg); opacity: 0; }
    to { transform: scale(1) rotate(0); opacity: 1; }
  }
  .effort-name { font-size: 13px; font-weight: 600; }
  .effort-hint { color: var(--muted-foreground); font-size: 11.5px; line-height: 1.35; }

  /* The effort spectrum runs under the whole track; only the part up to the
     thumb shows, so the fill warms as the level rises. */
  .effort-slider { position: relative; height: 1.25rem; }
  .effort-slider::before {
    content: '';
    position: absolute;
    inset: 50% auto auto 0;
    width: var(--pct);
    height: 6px;
    transform: translateY(-50%);
    border-radius: 9999px;
    background: linear-gradient(to right, var(--effort-low), var(--level));
    filter: blur(6px);
    opacity: 0.55;
    pointer-events: none;
    transition: width 180ms var(--motion-ease);
  }
  .effort-slider input {
    position: absolute;
    inset: 0;
    width: 100%;
    margin: 0;
    appearance: none;
    background: transparent;
    cursor: pointer;
  }
  .effort-slider input::-webkit-slider-runnable-track {
    height: 6px;
    border-radius: 9999px;
    background:
      linear-gradient(to right, transparent var(--pct), color-mix(in srgb, var(--foreground) 13%, var(--popover)) var(--pct)),
      linear-gradient(to right, var(--effort-low), var(--effort-mid), var(--effort-high));
  }
  .effort-slider input::-webkit-slider-thumb {
    appearance: none;
    width: 16px;
    height: 16px;
    margin-top: -5px;
    border-radius: 9999px;
    background: var(--popover);
    border: 3px solid var(--level);
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--level) 22%, transparent), 0 1px 3px rgb(0 0 0 / 0.25);
    transition: transform 120ms var(--motion-ease);
  }
  .effort-slider input:active::-webkit-slider-thumb { transform: scale(1.12); }
  .effort-slider input:focus-visible { outline: none; }
  .effort-slider input:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 4px color-mix(in srgb, var(--level) 45%, transparent); }
  .stops {
    position: absolute;
    inset: 50% 8px auto;
    display: flex;
    justify-content: space-between;
    transform: translateY(-50%);
    pointer-events: none;
    z-index: 1;
  }
  .stops span { width: 4px; height: 4px; border-radius: 9999px; background: color-mix(in srgb, var(--foreground) 25%, transparent); }
  .stops span.is-on { background: rgb(255 255 255 / 0.75); }
  .effort-name { color: var(--level); }

  .trigger-meter { display: inline-flex; color: var(--level); }

  .effort-ends { display: flex; justify-content: space-between; color: var(--muted-foreground); font-size: 11px; }

  @media (prefers-reduced-motion: reduce) {
    .effort-slider input::-webkit-slider-thumb { transition: none; }
    .effort-icon { animation: none; }
    .effort-slider::before { transition: none; }
  }
</style>

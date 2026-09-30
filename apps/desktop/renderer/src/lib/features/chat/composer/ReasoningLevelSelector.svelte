<svelte:options runes={true} />

<!--
  How hard the model thinks. The trigger is a tiny effort meter and the
  level's name; it opens a card whose slider is the meter drawn large — one
  rising bar per level this model supports, filled up to the choice — with
  one line on what the level means.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import ComposerCard from '$lib/features/shared/composer/ComposerCard.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import type { ReasoningLevel } from '$lib/types/chat';
  import { normalizeThinkingMode } from '$lib/stores/app-store-local-model';
  import { effortBars } from './reasoning-effort';

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
  /** The slider is a meter of thin rising bars; each level snaps to its share of them. */
  const BARS = Array.from({ length: 24 }, (_, bar) => bar);
  const filledBars = $derived(levels.length > 1 ? Math.round((index / (levels.length - 1)) * (BARS.length - 1)) : BARS.length - 1);

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
    {@render meter(current)}
    <span>{labelFor(current)}</span>
  </button>
  {#if open}
    <ComposerCard {anchor} {id} label={$t('composer.thinking.title')} onclose={() => (open = false)}>
      <div class="effort">
        <div class="effort-head">
          <span class="effort-name">{labelFor(current)}</span>
          <span class="effort-hint">{hintFor(current)}</span>
        </div>
        <!-- The bars are the slider: one per level, rising, filled up to the choice. -->
        <div class="effort-bars">
          {#each BARS as bar (bar)}
            <span class="bar" class:is-on={bar <= filledBars} style:height={`${14 + (bar / (BARS.length - 1)) * 86}%`}></span>
          {/each}
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
  .effort-head { display: grid; gap: 0.125rem; min-height: 2.4rem; }
  .effort-name { color: var(--foreground); font-size: 13px; font-weight: 600; }
  .effort-hint { color: var(--muted-foreground); font-size: 11.5px; line-height: 1.35; }

  /* Bars spread edge to edge, so the fill tracks the range's stops. */
  .effort-bars {
    position: relative;
    display: flex;
    height: 2.25rem;
    align-items: flex-end;
    justify-content: space-between;
    padding: 0 2px;
  }

  .bar {
    width: 4px;
    border-radius: 2px;
    background: var(--border-hover);
    transition: background-color 140ms var(--motion-ease), height 140ms var(--motion-ease), opacity 140ms;
  }

  .bar.is-on { background: var(--foreground); }

  /* A real range input over the bars: drag, click, arrow keys, screen readers. */
  .effort-bars input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }

  .effort-bars:has(input:focus-visible) {
    border-radius: 4px;
    outline: 2px solid var(--ring);
    outline-offset: 3px;
  }

  .effort-ends { display: flex; justify-content: space-between; color: var(--muted-foreground); font-size: 11px; }

  @media (prefers-reduced-motion: reduce) { .bar { transition: none; } }
</style>

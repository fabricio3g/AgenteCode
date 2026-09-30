<svelte:options runes={true} />

<!--
  How hard the model thinks. The trigger is a tiny effort meter and the
  level's name; it opens a card with a rectangular slider split into the
  levels this model supports, filled up to the choice, and one line on what
  the chosen level means.
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
  let bar = $state<HTMLDivElement>();

  function pick(step: number) {
    const next = levels[Math.max(0, Math.min(levels.length - 1, step))];
    if (next !== current) appStore.setReasoningLevel(next);
  }

  function stepAt(clientX: number): number {
    const rect = bar!.getBoundingClientRect();
    return Math.floor(((clientX - rect.left) / Math.max(1, rect.width)) * levels.length);
  }

  function startDrag(event: PointerEvent) {
    if (!bar) return;
    bar.setPointerCapture?.(event.pointerId);
    pick(stepAt(event.clientX));
    const move = (next: PointerEvent) => pick(stepAt(next.clientX));
    const up = () => { bar?.removeEventListener('pointermove', move); bar?.removeEventListener('pointerup', up); };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
  }

  function onKey(event: KeyboardEvent) {
    const moves: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 };
    if (event.key in moves) pick(index + moves[event.key]);
    else if (event.key === 'Home') pick(0);
    else if (event.key === 'End') pick(levels.length - 1);
    else return;
    event.preventDefault();
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
    {@render meter(current)}
    <span>{labelFor(current)}</span>
  </button>
  {#if open}
    <ComposerCard {anchor} {id} label={$t('composer.thinking.title')} onclose={() => (open = false)}>
      <div class="effort">
        <div class="effort-head">
          <span class="effort-title">{$t('composer.thinking.title')}</span>
          <span class="effort-name">{labelFor(current)}</span>
        </div>
        <!-- A rectangle split into one segment per level, filled up to the choice. -->
        <div
          bind:this={bar}
          class="effort-bar"
          role="slider"
          tabindex="0"
          aria-label={$t('composer.thinking.title')}
          aria-valuemin={0}
          aria-valuemax={levels.length - 1}
          aria-valuenow={index}
          aria-valuetext={labelFor(current)}
          onpointerdown={startDrag}
          onkeydown={onKey}
        >
          <span class="fill" style:width={`${((index + 1) / levels.length) * 100}%`}></span>
          {#each levels as level, step (level)}
            <span class="segment" class:is-on={step <= index}>{labelFor(level)}</span>
          {/each}
        </div>
        {#if hintFor(current)}<p class="effort-hint">{hintFor(current)}</p>{/if}
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
  .meter span.is-on { opacity: 1; background: var(--brand-accent); }
  .meter.is-auto span { opacity: 0.5; }

  .effort { display: grid; width: 17rem; gap: 0.5rem; }
  .effort-head { display: flex; align-items: baseline; justify-content: space-between; }
  .effort-title { color: var(--muted-foreground); font-size: 11.5px; font-weight: 500; }
  .effort-name { color: var(--brand-accent-strong); font-size: 12.5px; font-weight: 600; }

  .effort-bar {
    position: relative;
    display: flex;
    height: 1.875rem;
    overflow: hidden;
    border-radius: 0.5rem;
    background: var(--muted);
    box-shadow: inset 0 0 0 1px var(--border);
    cursor: pointer;
    touch-action: none;
    user-select: none;
  }

  .effort-bar:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }

  /* One hue, the app's accent, deepening toward the chosen level. */
  .fill {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: inherit;
    background: linear-gradient(to right, color-mix(in srgb, var(--brand-accent) 72%, var(--popover)), var(--brand-accent));
    box-shadow: 0 0 12px -2px color-mix(in srgb, var(--brand-accent) 55%, transparent), inset 0 1px 0 rgb(255 255 255 / 0.18);
    transition: width 160ms var(--motion-ease);
  }

  /* Segment labels sit inside the bar and invert where the fill covers them. */
  .segment {
    position: relative;
    display: flex;
    flex: 1;
    min-width: 0;
    align-items: center;
    justify-content: center;
    color: var(--muted-foreground);
    font-size: 11px;
    font-weight: 500;
    white-space: nowrap;
    transition: color 160ms var(--motion-ease);
  }

  .segment + .segment::before {
    content: '';
    position: absolute;
    inset: 25% auto 25% 0;
    width: 1px;
    background: var(--border-hover);
  }

  .segment.is-on { color: #fff; text-shadow: 0 1px 1px rgb(0 0 0 / 0.18); }
  .segment.is-on + .segment.is-on::before { background: rgb(255 255 255 / 0.3); }

  @media (prefers-reduced-motion: reduce) { .fill, .segment { transition: none; } }
  .effort-hint { margin: 0.125rem 0 0; padding-top: 0.5rem; border-top: 1px solid var(--border); color: var(--muted-foreground); font-size: 11.5px; line-height: 1.4; }
</style>

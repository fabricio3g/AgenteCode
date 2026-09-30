<svelte:options runes={true} />

<!--
  How hard the model thinks. The trigger is a tiny effort meter and the level's
  name; it opens a card with the value on the right of the title, the two ends
  of the scale named ("faster" / "deeper"), and a filled bar with one tick per
  level this model supports and a thumb at the choice.

  A bar, not a track of labelled segments: levels are read from the tick under
  the thumb, not from text squeezed between the dividers, which is what made a
  five- or six-level model print "AutoOffLowMediumHigh" as one smear. The name of
  the level lives in the header, where there is room for it, and what a level
  means lives on its tick's tooltip, so the card itself is a title, two words and
  a bar.
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
  let rail = $state<HTMLDivElement>();
  let dragging = $state(false);
  // Bumped on every level change, which remounts the fill's sheen and replays it.
  // `changed` keeps the sheen still until the first move, so opening the card is quiet.
  let sheenKey = $state(0);
  let changed = $state(false);
  const id = $props.id();
  const capabilities = $derived(appStore.reasoningCapabilities);
  const visible = $derived(capabilities.supported && capabilities.source !== 'unknown' && capabilities.levels.length > 1);
  const modelDefault = $derived(appStore.backendMode === 'local'
    ? normalizeThinkingMode(appStore.config.llm?.local?.thinking_mode, appStore.config.llm?.local?.disable_thinking)
    : 'auto');
  const levels = $derived<Array<ReasoningLevel | null>>([null, ...capabilities.levels]);
  const current = $derived(levels.includes(appStore.reasoningLevel) ? appStore.reasoningLevel : null);
  const index = $derived(levels.indexOf(current));
  // 0 at the first level, 1 at the last; a two-level model is a plain switch.
  const position = $derived(levels.length > 1 ? index / (levels.length - 1) : 0);

  function pick(step: number) {
    const next = levels[Math.max(0, Math.min(levels.length - 1, step))];
    // Same level, no call and no sheen: the bar should react to a change, not to
    // a pointer passing over the level already chosen.
    if (next === current) return;
    appStore.setReasoningLevel(next);
    changed = true;
    sheenKey += 1;
  }

  /** Where along the rail a pointer sits, snapped to the nearest level. */
  function stepAt(clientX: number): number {
    const rect = rail!.getBoundingClientRect();
    const span = Math.max(1, rect.width);
    return Math.round(((clientX - rect.left) / span) * (levels.length - 1));
  }

  function startDrag(event: PointerEvent) {
    if (!rail) return;
    dragging = true;
    rail.setPointerCapture?.(event.pointerId);
    pick(stepAt(event.clientX));
    const move = (next: PointerEvent) => pick(stepAt(next.clientX));
    const up = () => {
      dragging = false;
      rail?.removeEventListener('pointermove', move);
      rail?.removeEventListener('pointerup', up);
      rail?.removeEventListener('pointercancel', up);
    };
    rail.addEventListener('pointermove', move);
    rail.addEventListener('pointerup', up);
    rail.addEventListener('pointercancel', up);
  }

  function onKey(event: KeyboardEvent) {
    // A horizontal rail: right and down climb, left and up drop.
    const moves: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
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

  /** A tick's distance from the rail's left edge, as a fraction of its length. */
  function tickAt(step: number): number {
    return levels.length > 1 ? step / (levels.length - 1) : 0;
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
        <div class="effort-scale">
          <span class="effort-end">{$t('composer.thinking.ends.fast')}</span>
          <span class="effort-end">{$t('composer.thinking.ends.deep')}</span>
        </div>
        <!-- A bar with a tick per level: the level's name is read from the header,
             where there is room for it, not from text crushed between dividers. -->
        <div
          bind:this={rail}
          class="rail"
          class:is-dragging={dragging}
          role="slider"
          tabindex="0"
          aria-label={$t('composer.thinking.title')}
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={levels.length - 1}
          aria-valuenow={index}
          aria-valuetext={labelFor(current)}
          onpointerdown={startDrag}
          onkeydown={onKey}
        >
          <!-- Keyed on the level so each change remounts the sheen and replays it;
               the class holds it still until the first move. -->
          <span class="fill" style:width={`calc(10px + (100% - 20px) * ${position})`}>
            {#key sheenKey}<span class="sheen" class:is-live={changed} aria-hidden="true"></span>{/key}
          </span>
          {#each levels as level, step (level)}
            <!-- The level's meaning lives on the tick, not in the card: hover for
                 it, and the layout stays a bar with two words on it. -->
            <span class="tick" class:is-on={step <= index} style:left={`calc(10px + (100% - 20px) * ${tickAt(step)})`}
              title={hintFor(level) ? `${labelFor(level)} — ${hintFor(level)}` : labelFor(level)}></span>
          {/each}
          <span class="thumb" style:left={`calc(10px + (100% - 20px) * ${position})`}></span>
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
  .meter span.is-on { opacity: 1; background: var(--brand-accent); }
  .meter.is-auto span { opacity: 0.5; }

  .effort { display: grid; width: 18rem; gap: 0.375rem; }
  .effort-head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.75rem; }
  .effort-title { color: var(--muted-foreground); font-size: 11.5px; font-weight: 500; }
  .effort-name { color: var(--brand-accent-strong); font-size: 13px; font-weight: 600; }

  .effort-scale { display: flex; justify-content: space-between; }
  .effort-end { color: var(--muted-foreground); font-size: 10.5px; }

  /* A rectangle, not a hairline: a bar with room for a tick to sit inside it
     and for the fill to read as a solid quantity. */
  .rail {
    position: relative;
    height: 16px;
    margin: 0.25rem 0 0.5rem;
    border-radius: 5px;
    background: color-mix(in srgb, var(--muted) 70%, var(--border-subtle));
    box-shadow: inset 0 0 0 1px var(--border-subtle);
    cursor: pointer;
    touch-action: none;
    user-select: none;
  }

  /* The bar is already a comfortable target; this widens it for the pointer
     without changing what is drawn. */
  .rail::before {
    content: '';
    position: absolute;
    inset: -6px 0;
  }

  .rail:focus-visible { outline: 2px solid var(--ring); outline-offset: 3px; }
  .rail.is-dragging { cursor: grabbing; }

  /* One hue, the app's accent, deepening toward the chosen level, with a lit
     top edge so the bar reads as raised rather than painted. */
  .fill {
    position: absolute;
    inset: 0 auto 0 0;
    overflow: hidden;
    border-radius: inherit;
    background: linear-gradient(
      100deg,
      color-mix(in srgb, var(--brand-accent) 62%, var(--popover)) 0%,
      var(--brand-accent) 62%,
      color-mix(in srgb, var(--brand-accent) 88%, #000) 100%
    );
    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 0.28),
      inset 0 -1px 0 rgb(0 0 0 / 0.12);
    transition: width 200ms var(--motion-ease);
  }

  .rail.is-dragging .fill { transition: none; }

  /* A highlight travelling along the fill, so a change of level is felt and not
     only seen. Slow enough to read as a sheen, not a spinner. */
  .sheen {
    position: absolute;
    inset: 0;
    background: linear-gradient(
      100deg,
      transparent 0%,
      rgb(255 255 255 / 0.34) 46%,
      rgb(255 255 255 / 0.08) 56%,
      transparent 100%
    );
    transform: translateX(-100%);
  }

  @keyframes effortSheen {
    from { transform: translateX(-100%); }
    to { transform: translateX(100%); }
  }

  .sheen.is-live { animation: effortSheen 720ms var(--motion-ease); }

  @media (prefers-reduced-motion: reduce) {
    .sheen.is-live { animation: none; }
  }

  .tick {
    position: absolute;
    top: 50%;
    width: 3px;
    height: 3px;
    border-radius: 1px;
    background: var(--border-hover);
    transform: translate(-50%, -50%);
    transition: background-color 200ms var(--motion-ease);
  }

  .tick.is-on { background: rgb(255 255 255 / 0.62); }

  .thumb {
    position: absolute;
    top: 50%;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--popover);
    box-shadow:
      0 1px 2px rgb(0 0 0 / 0.3),
      0 0 0 1px rgb(0 0 0 / 0.08),
      0 2px 6px rgb(0 0 0 / 0.14);
    transform: translate(-50%, -50%);
    transition: left 200ms var(--motion-ease), box-shadow var(--motion-fast) var(--motion-ease);
  }

  .rail:hover .thumb,
  .rail:focus-visible .thumb {
    box-shadow:
      0 1px 2px rgb(0 0 0 / 0.3),
      0 0 0 1px rgb(0 0 0 / 0.08),
      0 0 0 5px color-mix(in srgb, var(--brand-accent) 16%, transparent);
  }

  .rail.is-dragging .thumb { transition: box-shadow var(--motion-fast) var(--motion-ease); }

  /* On a dark panel a white thumb needs a lit rim, not a dark one, to read. */
  :global(.dark) .thumb { box-shadow: 0 1px 3px rgb(0 0 0 / 0.55), 0 0 0 1px rgb(255 255 255 / 0.22); }
</style>

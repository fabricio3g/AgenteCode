<svelte:options runes={true} />

<!--
  How hard the model thinks. The trigger is a tiny effort meter and the level's
  name; it opens a small card: the title with the chosen level (and its
  thinking-token budget) on one line, a thin gradient bar with a dot per level
  and a thumb at the choice, and the two ends of the scale as captions.

  The levels, their order (low → high), the provider default Auto resolves to
  and each budget all come from the shared Rust core — the same profile Agente
  Code's TUI shows. What a level means lives on its stop's tooltip.

  Without props it drives the app's model. Given `capabilities`, `value` and
  `onchange` it picks a level for any other model (a bot's pinned one).
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import ComposerCard from '$lib/features/shared/composer/ComposerCard.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import type { ReasoningCapabilities, ReasoningLevel } from '$lib/types/chat';
  import { normalizeThinkingMode } from '$lib/stores/app-store-local-model';
  import { effortBars, formatBudget } from './reasoning-effort';

  let {
    capabilities: given,
    value,
    onchange
  }: {
    capabilities?: ReasoningCapabilities;
    value?: ReasoningLevel | null;
    onchange?: (level: ReasoningLevel | null) => void;
  } = $props();
  const controlled = $derived(!!given);

  let open = $state(false);
  let anchor = $state<HTMLButtonElement>();
  let rail = $state<HTMLDivElement>();
  let dragging = $state(false);
  // Bumped on every level change, which remounts the fill's sheen and replays it.
  // `changed` keeps the sheen still until the first move, so opening the card is quiet.
  let sheenKey = $state(0);
  let changed = $state(false);
  const id = $props.id();
  const capabilities = $derived(given ?? appStore.reasoningCapabilities);
  const known = $derived(capabilities.source !== 'unknown');
  // Auto plus at least one level is a choice.
  const visible = $derived(known && capabilities.supported && capabilities.levels.length > 0);
  // A model that always thinks and offers nothing to pick: say so, quietly.
  const alwaysThinking = $derived(known && !visible && capabilities.mandatory === true);
  const modelDefault = $derived<ReasoningLevel | 'auto'>(!controlled && appStore.backendMode === 'local'
    ? normalizeThinkingMode(appStore.config.llm?.local?.thinking_mode, appStore.config.llm?.local?.disable_thinking)
    : capabilities.default ?? 'auto');
  const levels = $derived<Array<ReasoningLevel | null>>([null, ...capabilities.levels]);
  const chosen = $derived(controlled ? (value ?? null) : appStore.reasoningLevel);
  const current = $derived(levels.includes(chosen) ? chosen : null);
  const index = $derived(levels.indexOf(current));
  // 0 at the first level, 1 at the last.
  const position = $derived(levels.length > 1 ? index / (levels.length - 1) : 0);
  const budget = $derived(current ? capabilities.budgets?.[current] : undefined);

  function pick(step: number) {
    const next = levels[Math.max(0, Math.min(levels.length - 1, step))];
    // Same level, no call and no sheen: the bar should react to a change, not to
    // a pointer passing over the level already chosen.
    if (next === current) return;
    if (controlled) onchange?.(next);
    else appStore.setReasoningLevel(next);
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

  function budgetFor(value: number): string {
    return $t('composer.thinking.budget', { values: { tokens: formatBudget(value) } });
  }

  /** A stop's place along the rail, inset by the thumb's radius at both ends. */
  function at(fraction: number): string {
    return `calc(7px + ${fraction} * (100% - 14px))`;
  }

  function stopAt(step: number): number {
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
    <ComposerCard {anchor} {id} bright label={$t('composer.thinking.title')} onclose={() => (open = false)}>
      <div class="effort">
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
          <span class="track" aria-hidden="true"></span>
          <!-- Keyed on the level so each change remounts the sheen and replays it;
               the class holds it still until the first move. -->
          <span class="fill" style:width={at(position)}>
            {#key sheenKey}<span class="sheen" class:is-live={changed} aria-hidden="true"></span>{/key}
          </span>
          {#each levels as level, step (level)}
            <span class="tick" class:is-on={step <= index} style:left={at(stopAt(step))}
              title={hintFor(level) ? `${labelFor(level)} — ${hintFor(level)}` : labelFor(level)}></span>
          {/each}
          <span class="thumb" style:left={at(position)}></span>
        </div>
        <!-- The trigger already names the level; the card adds only what it
             cannot show: the ends of the scale and the level's budget. -->
        <div class="effort-scale">
          <span>{$t('composer.thinking.ends.fast')}</span>
          {#if typeof budget === 'number'}<span class="effort-budget">{budgetFor(budget)}</span>{/if}
          <span>{$t('composer.thinking.ends.deep')}</span>
        </div>
      </div>
    </ComposerCard>
  {/if}
{:else if alwaysThinking}
  <span class="thinking-trigger is-static" title={$t('composer.thinking.hint.always')}>
    {@render meter('high')}
    <span>{$t('composer.thinking.always')}</span>
  </span>
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

  .thinking-trigger:not(.is-static):hover,
  .thinking-trigger.is-open {
    background: var(--surface-hover);
    color: var(--foreground);
  }

  .thinking-trigger:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }

  .is-static { cursor: default; }

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

  .effort { display: grid; width: 13rem; gap: 0.375rem; }

  .effort-budget { color: var(--foreground); }

  /* The ends of the scale, as quiet captions under the bar. */
  .effort-scale {
    display: flex;
    justify-content: space-between;
    color: var(--muted-foreground);
    font-size: 10.5px;
  }

  /* A thin bar; the whole scale is a light-to-accent gradient, so the ends
     read as "quick" and "deep" before the captions do. */
  .rail {
    position: relative;
    height: 14px;
    cursor: pointer;
    touch-action: none;
    user-select: none;
  }

  /* Widen the target for the pointer without changing what is drawn. */
  .rail::before {
    content: '';
    position: absolute;
    inset: -6px 0;
  }

  .rail:focus-visible { outline: 2px solid var(--ring); outline-offset: 3px; border-radius: 8px; }
  .rail.is-dragging { cursor: grabbing; }

  .track,
  .fill {
    position: absolute;
    top: 50%;
    left: 0;
    height: 6px;
    border-radius: 3px;
    transform: translateY(-50%);
  }

  .track {
    right: 0;
    background: color-mix(in srgb, var(--muted) 70%, var(--border));
  }

  .fill {
    overflow: hidden;
    background: linear-gradient(
      90deg,
      color-mix(in srgb, var(--brand-accent) 35%, #fff) 0%,
      var(--brand-accent) 100%
    );
    transition: width 200ms var(--motion-ease);
  }

  .rail.is-dragging .fill { transition: none; }

  /* A highlight travelling along the fill, so a change of level is felt and not
     only seen. */
  .sheen {
    position: absolute;
    inset: 0;
    background: linear-gradient(100deg, transparent 0%, rgb(255 255 255 / 0.45) 50%, transparent 100%);
    transform: translateX(-100%);
  }

  @keyframes effortSheen {
    from { transform: translateX(-100%); }
    to { transform: translateX(100%); }
  }

  .sheen.is-live { animation: effortSheen 600ms var(--motion-ease); }

  @media (prefers-reduced-motion: reduce) {
    .sheen.is-live { animation: none; }
    .fill, .thumb { transition: none; }
  }

  .tick {
    position: absolute;
    top: 50%;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: color-mix(in srgb, var(--muted-foreground) 45%, transparent);
    transform: translate(-50%, -50%);
    transition: background-color 200ms var(--motion-ease);
  }

  .tick.is-on { background: rgb(255 255 255 / 0.85); }

  .thumb {
    position: absolute;
    top: 50%;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #fff;
    box-shadow:
      0 0 0 1.5px var(--brand-accent),
      0 1px 3px rgb(0 0 0 / 0.2);
    transform: translate(-50%, -50%);
    transition: left 200ms var(--motion-ease), box-shadow var(--motion-fast) var(--motion-ease);
  }

  .rail:hover .thumb,
  .rail:focus-visible .thumb {
    box-shadow:
      0 0 0 1.5px var(--brand-accent),
      0 0 0 5px color-mix(in srgb, var(--brand-accent) 18%, transparent),
      0 1px 3px rgb(0 0 0 / 0.2);
  }

  .rail.is-dragging .thumb { transition: box-shadow var(--motion-fast) var(--motion-ease); }

  :global(.dark) .thumb { background: color-mix(in srgb, var(--popover) 70%, #fff); }
</style>

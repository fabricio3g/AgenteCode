<svelte:options runes={true} />

<!--
  How hard the model thinks. The trigger uses only the level's
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
  import UiButton from '$lib/components/ui/Button.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { t } from 'svelte-i18n';
  import { Brain, ChevronDown } from '$lib/icons';
  import ComposerCard from '$lib/features/shared/composer/ComposerCard.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { reasoningRouteIdentity } from '$lib/services/reasoning-route';
  import type { ReasoningCapabilities, ReasoningLevel } from '$lib/types/chat';
  import { normalizeThinkingMode } from '$lib/stores/app-store-local-model';
  import { formatBudget } from './reasoning-effort';

  let {
    capabilities: given,
    value,
    onchange,
    inline = false
  }: {
    capabilities?: ReasoningCapabilities;
    value?: ReasoningLevel | null;
    onchange?: (level: ReasoningLevel | null) => void;
    inline?: boolean;
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
  const appCapabilities = $derived(appStore.reasoningCapabilities);
  const routeMatches = $derived(!appCapabilities.route || appCapabilities.route === reasoningRouteIdentity(appStore.config));
  const capabilities = $derived(given ?? (routeMatches ? appCapabilities : { supported: false, levels: [], source: 'unknown' } as ReasoningCapabilities));
  const known = $derived(capabilities.source !== 'unknown');
  // Auto plus at least one level is a choice.
  const visible = $derived(known && capabilities.supported && capabilities.levels.length > 0);
  // A model that always thinks and offers nothing to pick: say so, quietly.
  const alwaysThinking = $derived(known && !visible && capabilities.mandatory === true);
  const modelDefault = $derived<ReasoningLevel | 'auto'>(!controlled && appStore.backendMode === 'local'
    ? normalizeThinkingMode(appStore.activeLoadConfig.thinking_mode)
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

{#if visible}
  <UiButton variant="plain" bind:ref={anchor} type="button" class={uiClass("thinking-trigger", "ui-local-efeab109", {"is-inline": inline, "composer-selector": inline, "is-open": open})}
    aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
    aria-label={$t('composer.thinking.trigger', { values: { level: labelFor(current) } })} title={$t('composer.thinking.title')}
    onclick={() => (open = !open)}>
    {#if inline}<Brain class="thinking-icon size-3 shrink-0" /><span class="thinking-prefix">{$t('composer.thinking.title')} ·</span>{/if}
    <span class="thinking-level">{labelFor(current)}</span>
    {#if inline}<ChevronDown class="thinking-chevron size-3 shrink-0" />{/if}
  </UiButton>
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
            <!-- Keyed on the same counter, so a change of level restarts the
                 drift and the stream visibly re-staggers as the sheen flashes.
                 The negative delays mean they come back mid-flight rather than
                 all from the left edge — a surge, not a glitch. No timer, no
                 extra state. -->
            {#key sheenKey}
              <span class="bubbles" aria-hidden="true">
                <span class="bubble"></span>
                <span class="bubble"></span>
                <span class="bubble"></span>
              </span>
            {/key}
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
    <span>{$t('composer.thinking.always')}</span>
  </span>
{/if}

<style>
  :is(.thinking-trigger, :global(.thinking-trigger.ui-local-efeab109)) {
    display: inline-flex;
    height: 26px;
    flex-shrink: 0;
    align-items: center;
    gap: 0.375rem;
    padding: 0 0.5rem;
    border-radius: var(--radius-full);
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  :global(.thinking-trigger.is-inline.ui-local-efeab109) { height:2rem;gap:0.25rem;font-size:var(--text-xs);padding-inline:0.25rem; }
  :is(.thinking-trigger, :global(.thinking-trigger.ui-local-efeab109)) :global(.thinking-icon) { display:none; }
  .thinking-prefix { display:none; }
  :global(.thinking-trigger.is-inline.ui-local-efeab109) :global(.thinking-icon) { display:block; }
  /* Narrow: the level folds into its icon (the label and tooltip still name it). */
  @container composer (max-width:480px) {
    .thinking-level, :is(.thinking-trigger, :global(.thinking-trigger.ui-local-efeab109)) :global(.thinking-chevron) { display:none; }
    :is(.thinking-trigger, :global(.thinking-trigger.ui-local-efeab109)) :global(.thinking-icon) { display:block; }
  }

  :is(.thinking-trigger:not(.is-static):hover, :global(.thinking-trigger:not(.is-static):hover.ui-local-efeab109)),
  :global(.thinking-trigger.is-open.ui-local-efeab109) {
    color: var(--foreground);
  }

  :is(.thinking-trigger:focus-visible, :global(.thinking-trigger:focus-visible.ui-local-efeab109)) {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }

  .is-static { cursor: default; }

  .effort { display: grid; width: 13rem; gap: 0.375rem; }

  .effort-budget { color: var(--foreground); }

  /* The ends of the scale, as quiet captions under the bar. `var(--text-xs)` is
     the 12px floor the type scale sets for caption text. */
  .effort-scale {
    display: flex;
    justify-content: space-between;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    letter-spacing: var(--tracking-caption);
  }

  /* A thick bar; the whole scale is a light-to-accent gradient, so the ends
     read as "quick" and "deep" before the captions do. */
  .rail {
    position: relative;
    height: 18px;
    cursor: pointer;
    touch-action: none;
    user-select: none;
    /* A width change on the fill must not cascade into the card's layout. */
    contain: layout;
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
    height: 10px;
    border-radius: 5px;
    transform: translateY(-50%);
    background-blend-mode: soft-light;
  }

  .track {
    right: 0;
    /* Grain first so it modulates the surface colour underneath. */
    background-image: var(--grain-noise), linear-gradient(
      180deg,
      color-mix(in srgb, var(--muted) 80%, var(--border)) 0%,
      color-mix(in srgb, var(--muted) 58%, var(--border)) 100%
    );
    background-size: 140px 140px, 100% 100%;
  }

  .fill {
    /* `clip` rather than `hidden`: same clipping, no scroll container. */
    overflow: clip;
    container-type: inline-size;
    background-image:
      var(--grain-noise),
      linear-gradient(
        90deg,
        color-mix(in srgb, var(--brand-accent) 35%, #fff) 0%,
        var(--brand-accent) 100%
      );
    background-size: 140px 140px, 100% 100%;
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

  /*
   * Bubbles drifting through the fill, so the bar reads as effort in motion
   * rather than only as a length. They are a *static* radial gradient that is
   * only ever moved, which is what keeps this cheap: no filter, no blur, no
   * box-shadow and no layout property is animated anywhere below.
   *
   * Three of them at different heights, sizes and delays, so the stream never
   * visibly loops. They hide once the fill is too short to hold them (Auto sits
   * at one thumb-width) rather than piling into a nub.
   */
  .bubbles {
    position: absolute;
    inset: 0;
    overflow: clip;
    border-radius: inherit;
    pointer-events: none;
  }

  @container (max-width: 24px) {
    .bubbles { display: none; }
  }

  .bubble {
    position: absolute;
    left: 0;
    width: 6px;
    height: 6px;
    /* Centred with a margin rather than a translate, so the animation below can
       own the transform outright. */
    margin-top: -3px;
    border-radius: 50%;
    background: radial-gradient(
      circle at 34% 30%,
      rgb(255 255 255 / 0.95),
      rgb(255 255 255 / 0.3) 55%,
      rgb(255 255 255 / 0) 72%
    );
    /* `translate`/`scale` are separate properties, so they compose with each
       other and never fight a centring transform. Both are compositor-only. */
    animation: bubbleDrift 2.9s linear infinite;
    /* Scoped on purpose. See app.css: `will-change` promoted the streaming
       caret's whole markdown body to a compositing layer and re-rasterised it
       on every DOM write. That was on a large, constantly-mutating element;
       three 6px dots with a static background inside a card that unmounts on
       close are the opposite case. Do not widen this. */
    will-change: translate, scale;
  }

  /* Off-centre heights, staggered so they cross rather than travel in a line. */
  .bubble:nth-child(1) { top: 32%; animation-duration: 2.9s; animation-delay: -0.4s; }
  .bubble:nth-child(2) { top: 62%; width: 4px; height: 4px; margin-top: -2px; animation-duration: 2.2s; animation-delay: -1.7s; }
  .bubble:nth-child(3) { top: 46%; width: 5px; height: 5px; margin-top: -2.5px; animation-duration: 3.4s; animation-delay: -2.6s; }

  @keyframes bubbleDrift {
    0%   { translate: -26px 0; scale: 0.7; opacity: 0; }
    14%  { opacity: 0.9; }
    86%  { opacity: 0.9; }
    100% { translate: 240px 0; scale: 1.15; opacity: 0; }
  }

  /* Stillness, not absence: the bubbles stay as a static scatter. */
  @media (prefers-reduced-motion: reduce) {
    .sheen.is-live { animation: none; }
    .fill, .thumb { transition: none; }
    .bubble { animation: none; will-change: auto; opacity: 0.55; translate: 40px 0; scale: 1; }
  }

  :global(.a11y-reduce-motion) .sheen.is-live { animation: none; }
  :global(.a11y-reduce-motion) .fill,
  :global(.a11y-reduce-motion) .thumb { transition: none; }
  :global(.a11y-reduce-motion) .bubble { animation: none; will-change: auto; opacity: 0.55; translate: 40px 0; scale: 1; }

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

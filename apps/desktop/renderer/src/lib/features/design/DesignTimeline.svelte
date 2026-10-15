<svelte:options runes={true} />

<!--
  The strip under the canvas that shows the open page's motion: every animation
  as a row on one time axis, a scrubber, play, replay and speed. The page is
  held while the strip is open and let go when it closes. Selecting a row
  outlines its target on the canvas; "Change this animation" adds the target to
  the chips the next message carries. Reduced motion here is a preview: the
  page's durations are cut the way a reduce block would cut them.
-->

<script lang="ts">
  import UiRange from '$lib/components/ui/Range.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { MousePointerClick, Pause, Play, RotateCcw, X } from 'lucide-svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
  import Switch from '$lib/components/ui/Switch.svelte';
  import { copy } from '$lib/copy';
  import { designStore } from './design.svelte';
  import { barGeometry, formatTime, TIMELINE_RATES, timelineSpan } from './design-motion';

  type Rate = (typeof TIMELINE_RATES)[number];

  let rate = $state<Rate>(1);
  let focusId = $state('');
  const motion = $derived(designStore.motion);
  const span = $derived(timelineSpan(motion.items));
  const selected = $derived(motion.items.find((item) => item.id === focusId) ?? null);
  const head = $derived(Math.min(100, (motion.time / span) * 100));
  const rateOptions = TIMELINE_RATES.map((value) => ({ value: String(value), label: `${value}×` }));

  // The page is held for as long as the strip is on screen, and let go when it goes.
  $effect(() => {
    designStore.sendAnim({ action: 'open' });
    return () => designStore.sendAnim({ action: 'close' });
  });

  function togglePlay() {
    designStore.sendAnim({ action: motion.playing ? 'pause' : 'play' });
  }

  function replay() {
    designStore.sendAnim({ action: 'replay' });
  }

  function setRate(value: string) {
    rate = Number(value) as Rate;
    designStore.sendAnim({ action: 'rate', rate });
  }

  function scrub(event: Event) {
    designStore.sendAnim({ action: 'seek', ms: Number((event.currentTarget as HTMLInputElement).value) });
  }

  function setReduced(on: boolean) {
    designStore.sendAnim({ action: 'reduced', on });
  }

  function choose(id: string) {
    focusId = focusId === id ? '' : id;
    designStore.sendAnim({ action: 'focus', id: focusId });
  }

  function changeThis() {
    if (selected) designStore.sendAnim({ action: 'pick', id: selected.id });
  }
</script>

<section class="timeline" aria-label={copy.design.timeline.title}>
  <header>
    <h2>{copy.design.timeline.title}</h2>
    <div class="transport">
      <IconButton label={motion.playing ? copy.design.timeline.pause : copy.design.timeline.play} class={motion.playing ? 'is-on' : ''} onclick={togglePlay}>
        {#if motion.playing}<Pause aria-hidden="true" />{:else}<Play aria-hidden="true" />{/if}
      </IconButton>
      <IconButton label={copy.design.timeline.replay} onclick={replay}><RotateCcw aria-hidden="true" /></IconButton>
    </div>
    <div class="reduced" title={copy.design.timeline.reducedHint}>
      <Switch checked={motion.reduced} label={copy.design.timeline.reduced} onchange={setReduced} />
      <span>{copy.design.timeline.reduced}</span>
    </div>
    <IconButton label={copy.design.timeline.close} onclick={() => (designStore.tray = null)}><X aria-hidden="true" /></IconButton>
  </header>

  {#if motion.items.length}
    <div class="scrub">
      <span class="time">{formatTime(motion.time)}</span>
      <UiRange class={uiClass('', "ui-local-c670c58b")}  min="0" max={span} step="1" value={motion.time} oninput={scrub} aria-label={copy.design.timeline.scrub} />
      <span class="time">{formatTime(span)}</span>
      <SegmentedControl label={copy.design.timeline.speed} options={rateOptions} value={String(rate)} shape="rect" onchange={setRate} />
    </div>
    <ul class="rows">
      {#each motion.items as item (item.id)}
        {@const bar = barGeometry(item, span)}
        <li>
          <Button variant="plain" type="button" class={uiClass("row", "ui-local-c670c58b", {"is-active": item.id === focusId})}  aria-pressed={item.id === focusId} onclick={() => choose(item.id)}>
            <span class="what"><code>{item.selector || item.tag}</code>{#if item.name}<span class="name">{item.name}</span>{/if}</span>
            <span class="track" aria-hidden="true">
              <span class="bar" style:left="{bar.left}%" style:width="{bar.width}%"></span>
              <span class="head" style:left="{head}%"></span>
            </span>
            <span class="length">{formatTime(item.duration)}</span>
          </Button>
        </li>
      {/each}
    </ul>
    {#if selected}
      <div class="actions">
        <Button variant="secondary" size="xs" onclick={changeThis}><MousePointerClick aria-hidden="true" />{copy.design.timeline.change}</Button>
      </div>
    {/if}
  {:else}
    <p class="none"><span>{copy.design.timeline.none}</span> {copy.design.timeline.noneHint}</p>
  {/if}
</section>

<style>
  .timeline {
    display: flex;
    max-height: 17rem;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.625rem 0.875rem 0.75rem;
    background: var(--background);
    box-shadow: 0 -1px 0 var(--border-subtle);
  }

  header { display: flex; align-items: center; gap: 0.5rem 0.75rem; }
  h2 { margin: 0; font-size: var(--text-xs); font-weight: 500; color: var(--muted-foreground); }
  .transport { display: inline-flex; align-items: center; gap: 0.25rem; }
  .transport :global(.is-on) { background: color-mix(in srgb, var(--brand-accent) 14%, transparent); }
  .reduced { display: inline-flex; min-width: 0; align-items: center; gap: 0.375rem; margin-left: auto; color: var(--muted-foreground); font-size: var(--text-xs); white-space: nowrap; }

  .scrub { display: flex; min-width: 0; align-items: center; gap: 0.5rem; }
  .time { min-width: 3.25rem; color: var(--muted-foreground); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  .time:last-child { text-align: right; }

  /* A hairline thumb-and-track scrubber in the accent, with the keyboard arrows a native range gives. */
  :global(input[type='range'].ui-local-c670c58b) {
    flex: 1;
    min-width: 0;
    height: 1rem;
    margin: 0;
    background: transparent;
    accent-color: var(--brand-accent);
    cursor: pointer;
  }

  .rows { display: flex; margin: 0; padding: 0; flex-direction: column; gap: 0.125rem; overflow-y: auto; list-style: none; }

  :global(.row.ui-local-c670c58b) {
    display: grid;
    width: 100%;
    grid-template-columns: minmax(7rem, 14rem) minmax(0, 1fr) 3.25rem;
    align-items: center;
    gap: 0.75rem;
    min-height: 1.75rem;
    padding: 0.125rem 0.5rem;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--foreground);
    font-size: var(--text-xs);
    text-align: left;
    cursor: pointer;
    transition: background-color var(--motion-fast) var(--motion-ease);
  }

  :global(.row:hover.ui-local-c670c58b) { background: var(--float-row-hover); }
  :global(.row.is-active.ui-local-c670c58b) { background: color-mix(in srgb, var(--brand-accent) 12%, transparent); }
  :global(.row:focus-visible.ui-local-c670c58b) { outline: 2px solid var(--brand-accent); outline-offset: -2px; }

  .what { display: flex; min-width: 0; align-items: baseline; gap: 0.375rem; }
  .what code { overflow: hidden; min-width: 0; font-family: var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
  .name { flex-shrink: 0; color: var(--muted-foreground); }

  .track { position: relative; height: 0.5rem; border-radius: var(--radius-full); background: color-mix(in srgb, var(--foreground) 6%, transparent); }
  .bar { position: absolute; top: 0; bottom: 0; min-width: 2px; border-radius: var(--radius-full); background: var(--muted-foreground); opacity: 0.6; }
  .head { position: absolute; top: -0.1875rem; bottom: -0.1875rem; width: 1px; background: var(--foreground); opacity: 0.6; }
  .length { color: var(--muted-foreground); font-variant-numeric: tabular-nums; text-align: right; }

  .actions { display: flex; justify-content: flex-end; }
  .none { margin: 0; color: var(--muted-foreground); font-size: var(--text-sm); }
  .none span { color: var(--foreground); }
</style>

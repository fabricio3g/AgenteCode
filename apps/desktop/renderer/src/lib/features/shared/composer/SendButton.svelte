<svelte:options runes={true} />

<!--
  The composer's one primary control, the same in Home and Code: an arrow
  to send, a square to stop while a run is going and the box is empty, the
  microphone while the box is empty and the model can take dictation. With
  text in the box a live run still gets the arrow: that is a steer, and Stop
  is one empty box (or Esc) away. Always present, so the bar keeps its shape;
  greyed out while idle with nothing to send.

  Dictation lives here rather than in the bar below: an empty field is the
  one moment there is nothing to send, so the send slot says what you can do
  instead of saying it in a second place. Typing gives the mic back to the
  bar, which never moves.
-->

<script lang="ts">
  import type { Snippet } from 'svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';

  import ComposerGlyph from './ComposerGlyph.svelte';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import { motionFly } from '$lib/utils/transitions';

  let {
    running,
    compact = false,
    stopShortcut,
    disabled = false,
    dictation,
    sendLabel,
    stopLabel,
    onsend,
    onstop
  }: {
    running: boolean;
    compact?: boolean;
    /** The key that also stops a run here (Code: Escape); shown in the tooltip. */
    stopShortcut?: string;
    disabled?: boolean;
    /** The send slot's microphone: its glyph, its label and what a click does. */
    dictation?: { label: string; onclick: () => void; glyph?: Snippet };
    sendLabel: string;
    stopLabel: string;
    onsend: () => void;
    onstop: () => void;
  } = $props();

  /** A live run with nothing typed: the button stops it. */
  const stopping = $derived(running && disabled);
  /** Nothing typed and no run to steer: the slot offers the microphone. */
  const dictates = $derived(!stopping && !!dictation && disabled);
  const action = $derived(stopping ? stopLabel : dictates ? dictation!.label : sendLabel);
  const glyph = $derived(stopping ? 'stop' : dictates ? 'mic' : 'send');

  function activate() {
    if (stopping) onstop();
    else if (dictates) dictation!.onclick();
    else onsend();
  }
</script>

<Tooltip label={action} shortcut={stopping ? stopShortcut : dictates ? undefined : 'enter'} position="top">
<IconButton
  variant="default"
  size={compact ? 'xs' : 'md'}
  label={action}
  title=""
  class={`composer-send ui-local-2f6b41d9 rounded-[var(--float-row-radius)]${stopping ? ' is-stop' : ''}${dictates ? ' is-dictate' : ''}`}
  disabled={!running && disabled && !dictates}
  onclick={activate}
>
  {#key glyph}
    <span class="send-glyph" in:motionFly={{ y: 3, duration: 150 }}>
      {#if dictates && dictation!.glyph}{@render dictation!.glyph()}{:else}<ComposerGlyph name={glyph} />{/if}
    </span>
  {/key}
</IconButton>
</Tooltip>

<style>
  /* Flat at rest: no fill, no shadow, just the glyph. The hover band is the
     only thing that appears, so the composer's one primary control never
     shouts over the sentence it sends. */
  :global(.composer-send.ui-local-2f6b41d9) {
    position: relative;
    background: transparent;
    color: var(--foreground);
    box-shadow: none;
    border-radius: var(--radius-full);
    width: 1.625rem;
    height: 1.625rem;
    margin-inline: 0.125rem;
    transition: opacity var(--motion-instant) var(--motion-ease),
      background-color var(--motion-instant) var(--motion-ease),
      color var(--motion-instant) var(--motion-ease);
  }
  /* On hover the band fills and the glyph flips to the contrasting ink, so the
     arrow reads as white-on-dark or black-on-light whichever theme is up. */
  :global(.composer-send.ui-local-2f6b41d9:not(:disabled):hover) {
    background: var(--foreground);
    color: var(--background);
  }
  /* Nothing to send: the glyph recedes, the control keeps its shape. */
  :global(.composer-send.ui-local-2f6b41d9:disabled) {
    opacity: 1;
    background: transparent;
    color: var(--muted-foreground);
    box-shadow: none;
  }
  /* The slot's microphone: the empty field's affordance rather than a second
     action, so it stays quieter than the send arrow it stands in for. */
  :global(.composer-send.ui-local-2f6b41d9.is-dictate) {
    background: transparent;
    color: var(--muted-foreground);
  }
  :global(.composer-send.ui-local-2f6b41d9.is-dictate:hover) {
    background: var(--foreground);
    color: var(--background);
  }
  .send-glyph { display: inline-flex; align-items: center; justify-content: center; }
  .send-glyph :global(svg) { width: 0.875rem; height: 0.875rem; stroke-width: 2; }
</style>

<svelte:options runes={true} />

<!--
  The composer's one primary control, the same in Home and Code: an arrow
  to send, a square to stop while a run is going and the box is empty. With
  text in the box a live run still gets the arrow: that is a steer, and Stop
  is one empty box (or Esc) away. Always present, so the bar keeps its shape;
  greyed out while idle with nothing to send.
-->

<script lang="ts">
  import IconButton from '$lib/components/ui/IconButton.svelte';

  import ComposerGlyph from './ComposerGlyph.svelte';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import { motionFly } from '$lib/utils/transitions';

  let {
    running,
    compact = false,
    stopShortcut,
    disabled = false,
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
    sendLabel: string;
    stopLabel: string;
    onsend: () => void;
    onstop: () => void;
  } = $props();

  /** A live run with nothing typed: the button stops it. */
  const stopping = $derived(running && disabled);
</script>

<Tooltip label={stopping ? stopLabel : sendLabel} shortcut={stopping ? stopShortcut : 'enter'} position="top">
<IconButton
  variant="default"
  size={compact ? 'xs' : 'md'}
  label={stopping ? stopLabel : sendLabel}
  title=""
  class={`composer-send ui-local-2f6b41d9 rounded-full${stopping ? ' is-stop' : ''}`}
  disabled={!running && disabled}
  onclick={() => (stopping ? onstop() : onsend())}
>
  {#key stopping}
    <span class="send-glyph" in:motionFly={{ y: 3, duration: 150 }}>
      <ComposerGlyph name={stopping ? 'stop' : 'send'} />
    </span>
  {/key}
</IconButton>
</Tooltip>

<style>
  :global(.composer-send.ui-local-2f6b41d9) {
    position: relative;
    background: var(--primary);
    color: var(--primary-foreground);
    box-shadow: none;
    width: 1.75rem;
    height: 1.75rem;
    margin-inline: 0.125rem;
    transition: opacity var(--motion-instant) var(--motion-ease),
      background-color var(--motion-instant) var(--motion-ease);
  }
  :global(.composer-send.ui-local-2f6b41d9:not(:disabled):hover) {
    background: var(--primary-hover);
  }
  :global(.composer-send.ui-local-2f6b41d9:disabled) {
    opacity: 1;
    background: color-mix(in srgb, var(--foreground) 22%, var(--composer-surface));
    color: var(--composer-surface);
  }
  .send-glyph { display: inline-flex; align-items: center; justify-content: center; }
  .send-glyph :global(svg) { width: 0.875rem; height: 0.875rem; stroke-width: 2; }
</style>

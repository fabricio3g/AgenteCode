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

  import { ArrowUp, Square } from 'lucide-svelte';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';

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
  {#if stopping}<Square class="size-3 fill-current stroke-[2.75]" />{:else}<ArrowUp class="size-3.5 stroke-[2.75]" />{/if}
</IconButton>
</Tooltip>

<style>
  /*
    The one primary control wears the brand orange when it is live — there is
    something to send — and stays quiet when it is not, so the eye finds the
    action, not the chrome. A slow grain of dots drifts across the fill (one
    tile step per loop, so the pattern never seams), the same tile motif the
    app's live status surfaces carry. Stop keeps the neutral fill: only a
    send is orange.
  */
  :global(.composer-send.ui-local-2f6b41d9) {
    position: relative;
    overflow: hidden;
    background: var(--brand-accent);
    color: #fff;
    box-shadow: 0 1px 2px color-mix(in srgb, var(--brand-accent) 40%, transparent);
  }

  :global(.composer-send.ui-local-2f6b41d9:not(:disabled):not(.is-stop):hover) {
    background: color-mix(in srgb, var(--brand-accent) 86%, #000);
  }

  :global(.composer-send.ui-local-2f6b41d9:disabled),
  :global(.composer-send.is-stop.ui-local-2f6b41d9) {
    background: var(--primary);
    color: var(--primary-foreground);
    box-shadow: none;
  }

  :global(.composer-send.ui-local-2f6b41d9:not(:disabled):not(.is-stop))::before {
    content: '';
    position: absolute;
    inset: -60%;
    background-image: radial-gradient(rgb(255 255 255 / 0.6) 1px, transparent 1.2px);
    background-size: 5px 5px;
    opacity: 0.35;
    animation: sendDots 6s linear infinite;
    pointer-events: none;
  }

  :global(.composer-send.ui-local-2f6b41d9:not(:disabled):not(.is-stop):hover)::before {
    opacity: 0.55;
  }

  /* The glyph rides above the grain. */
  :global(.composer-send.ui-local-2f6b41d9 svg) {
    position: relative;
  }

  @keyframes sendDots {
    to { transform: translate3d(-5px, -5px, 0); }
  }

  @media (prefers-reduced-motion: reduce) {
    :global(.composer-send.ui-local-2f6b41d9:not(:disabled):not(.is-stop))::before {
      animation: none;
    }
  }
</style>

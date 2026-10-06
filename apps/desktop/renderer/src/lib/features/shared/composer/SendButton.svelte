<svelte:options runes={true} />

<!--
  The composer's one primary control, the same in Home and Code: an arrow
  to send, a square to stop while a run is going and the box is empty. With
  text in the box a live run still gets the arrow: that is a steer, and Stop
  is one empty box (or Esc) away. Always present, so the bar keeps its shape;
  greyed out while idle with nothing to send.
-->

<script lang="ts">
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
<button
  type="button"
  class="composer-send"
  class:is-stop={stopping}
  class:is-compact={compact}
  disabled={!running && disabled}
  onclick={() => (stopping ? onstop() : onsend())}
  aria-label={stopping ? stopLabel : sendLabel}
>
  {#if stopping}
    <Square class="size-3 fill-current stroke-[2.75]" />
  {:else}
    <ArrowUp class="size-3.5 stroke-[2.75]" />
  {/if}
</button>
</Tooltip>

<style>
  .composer-send {
    display: inline-flex;
    width: 1.75rem;
    height: 1.75rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 9999px;
    background: var(--primary);
    color: var(--primary-foreground);
    transition: opacity var(--motion-fast) var(--motion-ease), transform var(--motion-fast) var(--motion-ease), background-color var(--motion-fast) var(--motion-ease);
  }
  .composer-send.is-compact {width:1.5rem;height:1.5rem;}
  .composer-send:hover:not(:disabled) { opacity: 0.88; }
  .composer-send:active:not(:disabled) { transform: scale(0.96); }
  .composer-send:disabled {
    background: color-mix(in srgb, var(--foreground) 22%, transparent);
    color: var(--background);
    cursor: default;
  }
  .composer-send:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--ring) 45%, transparent);
  }
</style>

<svelte:options runes={true} />

<!--
  The composer's one primary control, the same in Home and Code: an arrow
  to send, a square to stop while a run is going. Always present, so the bar
  keeps its shape; greyed out while there is nothing to send.
-->

<script lang="ts">
  import { ArrowUp, Square } from 'lucide-svelte';

  let {
    running,
    disabled = false,
    sendLabel,
    stopLabel,
    onsend,
    onstop
  }: {
    running: boolean;
    disabled?: boolean;
    sendLabel: string;
    stopLabel: string;
    onsend: () => void;
    onstop: () => void;
  } = $props();
</script>

<button
  type="button"
  class="composer-send"
  class:is-stop={running}
  disabled={!running && disabled}
  onclick={() => (running ? onstop() : onsend())}
  aria-label={running ? stopLabel : sendLabel}
  title={running ? stopLabel : sendLabel}
>
  {#if running}
    <Square class="size-3 fill-current stroke-[2.75]" />
  {:else}
    <ArrowUp class="size-4 stroke-[2.75]" />
  {/if}
</button>

<style>
  .composer-send {
    display: inline-flex;
    width: 2rem;
    height: 2rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 9999px;
    background: var(--primary);
    color: var(--primary-foreground);
    transition: opacity var(--motion-fast) var(--motion-ease), transform var(--motion-fast) var(--motion-ease), background-color var(--motion-fast) var(--motion-ease);
  }
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

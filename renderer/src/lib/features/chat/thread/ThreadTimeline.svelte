<svelte:options runes={true} />

<!--
  The right-rail conversation dial: one tick per turn, wheel to browse, click to
  jump. Extracted from the message list so the list is about scrolling and the
  dial is about navigation.
-->

<script lang="ts">
  import { conversationDialWindow } from '$lib/utils/conversation-timeline';
  import type { TimelineMarker } from './timeline';

  interface Props {
    markers: TimelineMarker[];
    /** Index of the turn the dial currently points at. */
    index: number;
    onselect: (index: number, messageId: string) => void;
    onbrowse: (index: number) => void;
  }

  let { markers, index, onselect, onbrowse }: Props = $props();

  const WHEEL_THROTTLE_MS = 70;

  let hoveredId = $state<string | null>(null);
  let lastWheelAt = 0;

  const windowed = $derived.by(() =>
    conversationDialWindow(markers.length, index).map((entry) => ({
      ...markers[entry.index],
      ...entry
    }))
  );
  const dialPosition = $derived(
    windowed.find((marker) => marker.distance === 0)?.position ?? 50
  );

  function handleWheel(event: WheelEvent) {
    event.preventDefault();
    event.stopPropagation();
    const now = performance.now();
    if (now - lastWheelAt < WHEEL_THROTTLE_MS || Math.abs(event.deltaY) < 1) return;
    lastWheelAt = now;
    onbrowse(index + (event.deltaY > 0 ? 1 : -1));
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    hoveredId = null;
    (event.currentTarget as HTMLElement).blur();
  }
</script>

<nav
  class="conversation-timeline"
  aria-label="Conversation dial. Use the mouse wheel to browse turns."
  onwheel={handleWheel}
  onmouseleave={() => (hoveredId = null)}
>
  <div class="timeline-scale">
    <span class="timeline-position-dot" style={`top:${dialPosition}%;`} aria-hidden="true"></span>

    {#each windowed as marker (marker.id)}
      <div
        class="timeline-marker"
        style={`top:${marker.position}%;`}
        role="group"
        aria-label={marker.role === 'user' ? 'User message marker' : 'Assistant response marker'}
        onmouseenter={() => (hoveredId = marker.id)}
        onmouseleave={() => (hoveredId = null)}
      >
        <button
          type="button"
          class="timeline-marker-button"
          class:timeline-user={marker.role === 'user'}
          class:timeline-assistant={marker.role === 'assistant'}
          class:timeline-active={marker.distance === 0}
          class:timeline-near={Math.abs(marker.distance) === 1}
          class:timeline-mid={Math.abs(marker.distance) === 2}
          class:timeline-far={Math.abs(marker.distance) >= 3}
          aria-label={`Jump to ${marker.role === 'user' ? 'user message' : 'assistant response'}: ${marker.preview}`}
          aria-describedby={hoveredId === marker.id ? `timeline-tooltip-${marker.index}` : undefined}
          aria-current={marker.distance === 0 ? 'true' : undefined}
          onclick={() => onselect(marker.index, marker.id)}
          onfocus={() => (hoveredId = marker.id)}
          onblur={() => (hoveredId = null)}
          onkeydown={handleKeydown}
        >
          <span class="timeline-line" aria-hidden="true"></span>
        </button>

        {#if hoveredId === marker.id}
          <div id={`timeline-tooltip-${marker.index}`} class="timeline-tooltip" role="tooltip">
            <span class="timeline-tooltip-role">{marker.role === 'user' ? 'You' : 'Assistant'}</span>
            <span class="timeline-tooltip-preview">{marker.preview}</span>
          </div>
        {/if}
      </div>
    {/each}
  </div>
</nav>

<style>
  .conversation-timeline {
    position: absolute;
    top: 50%;
    right: 0.25rem;
    z-index: var(--z-sticky);
    width: 1.35rem;
    height: min(8rem, calc(100% - 3rem));
    transform: translateY(-50%);
    border: 1px solid color-mix(in srgb, var(--border) 58%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, var(--chat-bg) 82%, var(--card));
    box-shadow: var(--shadow-xs);
    pointer-events: none;
  }

  .timeline-scale {
    position: absolute;
    inset: 0.55rem 0.22rem;
  }

  .timeline-position-dot {
    position: absolute;
    left: -0.08rem;
    z-index: 3;
    width: 3px;
    height: 3px;
    transform: translate(-50%, -50%);
    border-radius: 999px;
    background: var(--foreground);
    box-shadow: 0 0 0 2px var(--chat-bg);
    transition: top 120ms linear;
  }

  .timeline-marker {
    position: absolute;
    inset-inline: 0;
    z-index: 2;
    height: 0;
    pointer-events: auto;
    transition: top 140ms var(--motion-ease);
  }

  .timeline-marker-button {
    position: absolute;
    top: 0;
    right: 0;
    display: flex;
    width: 0.8rem;
    height: 0.5rem;
    padding: 0;
    transform: translateY(-50%);
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 999px;
    background: transparent;
    cursor: pointer;
    outline: none;
  }

  .timeline-line {
    display: block;
    height: 1px;
    border-radius: 999px;
    opacity: 0.16;
    transition:
      width 120ms ease,
      opacity 120ms ease,
      background-color 120ms ease;
  }

  .timeline-user .timeline-line {
    width: 0.3rem;
    background: var(--muted-foreground);
  }

  .timeline-assistant .timeline-line {
    width: 0.24rem;
    background: var(--muted-foreground);
  }

  .timeline-active .timeline-line {
    width: 0.7rem;
    height: 2px;
    opacity: 1;
    background: var(--foreground);
  }

  .timeline-near .timeline-line {
    width: 0.52rem;
    opacity: 0.68;
  }

  .timeline-mid .timeline-line {
    width: 0.4rem;
    opacity: 0.4;
  }

  .timeline-far .timeline-line {
    width: 0.26rem;
    opacity: 0.14;
  }

  .timeline-marker-button:hover .timeline-line,
  .timeline-marker-button:focus-visible .timeline-line {
    width: 0.66rem;
    opacity: 1;
    background: var(--foreground);
  }

  .timeline-marker-button:focus-visible {
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--ring) 36%, transparent);
  }

  .timeline-tooltip {
    position: absolute;
    top: 0;
    right: calc(100% + 0.65rem);
    display: flex;
    width: min(13rem, calc(100vw - 4rem));
    max-height: 5rem;
    padding: 0.42rem 0.5rem;
    transform: translateY(-50%);
    flex-direction: column;
    gap: 0.2rem;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--popover);
    box-shadow: var(--shadow-lg);
    color: var(--popover-foreground);
    pointer-events: auto;
    animation: timelineTooltipIn 120ms ease-out;
  }

  .timeline-tooltip-role {
    color: var(--muted-foreground);
    font-size: 0.58rem;
    font-weight: 650;
    letter-spacing: 0.035em;
    line-height: 1.2;
    text-transform: uppercase;
  }

  .timeline-tooltip-preview {
    display: -webkit-box;
    overflow: hidden;
    font-size: 0.69rem;
    line-height: 1.35;
    overflow-wrap: anywhere;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
  }

  @keyframes timelineTooltipIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @media (prefers-reduced-motion: reduce) {
    .timeline-marker,
    .timeline-line,
    .timeline-position-dot {
      transition: none;
    }

    .timeline-tooltip {
      animation: none;
    }
  }
</style>

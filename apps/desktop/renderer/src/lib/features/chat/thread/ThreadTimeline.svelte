<svelte:options runes={true} />

<!--
  The right-rail conversation dial: one hairline tick per turn, wheel or
  arrow keys to browse, click or Enter to jump. It stays faint until the
  thread is hovered or scrolled, so it never competes with the messages.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { conversationDialWindow } from '$lib/utils/conversation-timeline';
  import type { TimelineMarker } from './timeline';

  interface Props {
    markers: TimelineMarker[];
    /** Index of the turn the dial currently points at. */
    index: number;
    /** True right after a scroll: wake the dial up. */
    awake?: boolean;
    onselect: (index: number, messageId: string) => void;
    onbrowse: (index: number) => void;
  }

  let { markers, index, awake = false, onselect, onbrowse }: Props = $props();

  const WHEEL_THROTTLE_MS = 70;

  let hoveredId = $state<string | null>(null);
  let lastWheelAt = 0;

  const windowed = $derived.by(() =>
    conversationDialWindow(markers.length, index).map((entry) => ({
      ...markers[entry.index],
      ...entry
    }))
  );

  function roleLabel(role: TimelineMarker['role']): string {
    return role === 'user' ? $t('chat.dial.you') : $t('chat.dial.assistant');
  }

  function previewOf(marker: TimelineMarker): string {
    return marker.preview || $t('chat.dial.noText');
  }

  function handleWheel(event: WheelEvent) {
    event.preventDefault();
    event.stopPropagation();
    const now = performance.now();
    if (now - lastWheelAt < WHEEL_THROTTLE_MS || Math.abs(event.deltaY) < 1) return;
    lastWheelAt = now;
    onbrowse(index + (event.deltaY > 0 ? 1 : -1));
  }

  function handleKeydown(event: KeyboardEvent, markerIndex: number) {
    if (event.key === 'Escape') {
      hoveredId = null;
      (event.currentTarget as HTMLElement).blur();
      return;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const next = Math.min(markers.length - 1, Math.max(0, markerIndex + (event.key === 'ArrowDown' ? 1 : -1)));
    onbrowse(next);
    // Keep focus on the tick for the turn we moved to once it renders.
    requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(`[data-dial-index="${next}"]`);
      target?.focus();
    });
  }
</script>

<nav
  class="dial"
  class:is-awake={awake || hoveredId !== null}
  aria-label={$t('chat.dial.label')}
  onwheel={handleWheel}
  onmouseleave={() => (hoveredId = null)}
>
  {#each windowed as marker (marker.id)}
    <div
      class="dial-marker"
      style={`top:${marker.position}%;`}
      role="presentation"
      onmouseenter={() => (hoveredId = marker.id)}
    >
      <button
        type="button"
        class="dial-tick"
        class:is-user={marker.role === 'user'}
        data-distance={Math.min(3, Math.abs(marker.distance))}
        data-dial-index={marker.index}
        aria-label={$t('chat.dial.jumpTo', { values: { role: roleLabel(marker.role), text: previewOf(marker) } })}
        aria-current={marker.distance === 0 ? 'true' : undefined}
        onclick={() => onselect(marker.index, marker.id)}
        onfocus={() => (hoveredId = marker.id)}
        onblur={() => (hoveredId = null)}
        onkeydown={(event) => handleKeydown(event, marker.index)}
      >
        <span class="dial-line" aria-hidden="true"></span>
      </button>

      {#if hoveredId === marker.id}
        <div class="dial-tip" role="tooltip">
          <span class="dial-tip-role">{roleLabel(marker.role)}</span>
          <span class="dial-tip-text">{previewOf(marker)}</span>
        </div>
      {/if}
    </div>
  {/each}
</nav>

<style>
  .dial {
    position: absolute;
    top: 50%;
    right: 0.375rem;
    z-index: var(--z-sticky);
    width: 1.5rem;
    height: min(9rem, calc(100% - 3rem));
    transform: translateY(-50%);
    border-radius: 9999px;
    opacity: 0.45;
    transition:
      opacity var(--motion-fast) var(--motion-ease),
      background-color var(--motion-fast) var(--motion-ease);
  }
  /* Wake up when the thread is hovered, the dial is used, or you scroll. */
  :global(.thread-wrapper:hover) .dial,
  .dial:focus-within,
  .dial.is-awake {
    opacity: 1;
  }
  .dial:hover,
  .dial:focus-within {
    background: color-mix(in srgb, var(--muted) 80%, transparent);
  }

  .dial-marker {
    position: absolute;
    inset-inline: 0;
    height: 0;
    transition: top 140ms var(--motion-ease);
  }

  .dial-tick {
    position: absolute;
    top: 0;
    right: 0.3rem;
    display: flex;
    width: 0.9rem;
    height: 0.625rem;
    padding: 0;
    transform: translateY(-50%);
    align-items: center;
    justify-content: flex-end;
    border: 0;
    border-radius: 9999px;
    background: transparent;
    cursor: pointer;
    outline: none;
  }

  .dial-line {
    display: block;
    width: 0.375rem;
    height: 1px;
    border-radius: 9999px;
    background: var(--muted-foreground);
    transition:
      width 120ms ease,
      opacity 120ms ease,
      background-color 120ms ease;
  }
  .dial-tick.is-user .dial-line {
    width: 0.625rem;
  }
  .dial-tick[data-distance='1'] .dial-line { opacity: 0.55; }
  .dial-tick[data-distance='2'] .dial-line { opacity: 0.35; }
  .dial-tick[data-distance='3'] .dial-line { opacity: 0.2; }
  .dial-tick[aria-current='true'] .dial-line {
    width: 0.875rem;
    height: 2px;
    background: var(--foreground);
  }
  .dial-tick:hover .dial-line,
  .dial-tick:focus-visible .dial-line {
    width: 0.875rem;
    opacity: 1;
    background: var(--foreground);
  }
  .dial-tick:focus-visible {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--ring) 35%, transparent);
  }

  .dial-tip {
    position: absolute;
    top: 0;
    right: calc(100% + 0.5rem);
    display: flex;
    width: 15rem;
    max-width: calc(100vw - 5rem);
    padding: 0.5rem 0.75rem;
    transform: translateY(-50%);
    flex-direction: column;
    gap: 0.125rem;
    border: 1px solid var(--float-border);
    border-radius: var(--float-radius);
    background: var(--float-bg);
    box-shadow: var(--float-shadow);
    color: var(--popover-foreground);
    pointer-events: none;
    animation: dial-tip-in 120ms ease-out;
  }
  .dial-tip-role {
    font-size: 11px;
    font-weight: 500;
    color: var(--muted-foreground);
  }
  .dial-tip-text {
    display: -webkit-box;
    overflow: hidden;
    font-size: 12.5px;
    line-height: 1.45;
    overflow-wrap: anywhere;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
  }

  @keyframes dial-tip-in {
    from { opacity: 0; transform: translate(4px, -50%); }
    to { opacity: 1; transform: translate(0, -50%); }
  }

  @media (prefers-reduced-motion: reduce) {
    .dial,
    .dial-marker,
    .dial-line {
      transition: none;
    }
    .dial-tip {
      animation: none;
    }
  }
</style>

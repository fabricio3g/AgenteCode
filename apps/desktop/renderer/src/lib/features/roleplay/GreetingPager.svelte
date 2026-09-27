<svelte:options runes={true} />

<!--
  Greeting pager: ‹ 1 / 3 › — rendered below the greeting bubble so the
  opening can be flipped in place, like swiping a chat message.
-->

<script lang="ts">
  import { ChevronLeft, ChevronRight } from 'lucide-svelte';

  interface Props {
    count: number;
    index: number;
    onchange: (index: number) => void;
  }

  let { count, index, onchange }: Props = $props();
</script>

<div class="greeting-pager" role="group" aria-label="Opening greeting">
  <button
    type="button"
    class="pager-btn"
    aria-label="Previous greeting"
    onclick={() => onchange((index - 1 + count) % count)}
  >
    <ChevronLeft class="size-3.5" />
  </button>
  <span class="pager-count" aria-live="polite">{index + 1} / {count}</span>
  <button
    type="button"
    class="pager-btn"
    aria-label="Next greeting"
    onclick={() => onchange((index + 1) % count)}
  >
    <ChevronRight class="size-3.5" />
  </button>
</div>

<style>
  .greeting-pager {
    display: inline-flex;
    align-items: center;
    gap: 0.125rem;
    margin-top: 0.5rem;
    padding: 0.125rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: var(--card);
  }

  .pager-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.375rem;
    height: 1.375rem;
    border: none;
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    transition:
      background-color var(--motion-fast) var(--motion-ease),
      color var(--motion-fast) var(--motion-ease);
  }

  .pager-btn:hover {
    background: var(--surface-hover);
    color: var(--foreground);
  }

  .pager-count {
    min-width: 2.25rem;
    text-align: center;
    color: var(--text-muted);
    font-size: 0.6875rem;
    font-variant-numeric: tabular-nums;
  }
</style>

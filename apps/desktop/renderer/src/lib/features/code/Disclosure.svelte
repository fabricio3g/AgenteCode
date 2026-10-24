<svelte:options runes={true} />

<!--
  The transcript's only disclosure.

  Five components used to hand-roll this button — a work block, a step, a
  thought, a subagent and the subagent group — each with its own `open` flag, its
  own chevron and its own idea of what a row looks like. That is why a subagent
  running three hundred tool calls and a `grep` that took four milliseconds read
  the same. The levels below are the whole hierarchy: one place decides how deep
  a row sits and how loud it is.

  The caller supplies a default, and the reader's own choice always wins.
  Work and reasoning stay folded until the reader asks to see them.
-->

<script lang="ts">
  import UiButton from '$lib/components/ui/Button.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import type { Snippet } from 'svelte';
  import { ChevronRight } from 'lucide-svelte';
  import { disclosure } from './disclosure-state.svelte';

  let {
    id,
    level = 'step',
    variant = 'row',
    chevron = 'trailing',
    defaultOpen = false,
    disabled = false,
    onActivate,
    header,
    actions,
    body
  }: {
    /** Store key; build it with `disclosureKey` so it survives a remount. */
    id: string;
    /** Where the row sits in the hierarchy. */
    level?: 'block' | 'step' | 'subagent' | 'thought';
    /**
     * How the row is drawn. A `card` is an object of its own: it brings its own
     * boundary, so the head drops its padding and the body its rail — one
     * border per side is the point.
     */
    variant?: 'row' | 'card';
    /** Which end the chevron sits on. A block and a subagent lead with it. */
    chevron?: 'leading' | 'trailing';
    defaultOpen?: boolean;
    /** A row with nothing to reveal: no chevron, no toggle, no focus stop. */
    disabled?: boolean;
    /** A row that acts instead of opening (a presented plan opens the dock). */
    onActivate?: () => void;
    header: Snippet;
    /** Buttons that belong to the row but outside its toggle (Stop, …). */
    actions?: Snippet;
    body?: Snippet;
  } = $props();

  const open = $derived(disclosure.isOpen(id, defaultOpen));
  const expandable = $derived(!disabled && !onActivate && !!body);

  function toggle() {
    const activate = onActivate;
    if (activate) activate();
    else if (expandable) disclosure.toggle(id, defaultOpen);
  }
</script>

<div class="disclosure level-{level}" class:is-card={variant === 'card'}>
  <div class="row">
    <UiButton variant="plain"
      type="button"
      class={uiClass("head", "ui-local-2c22291d")}
      aria-expanded={expandable ? open : undefined}
      disabled={!expandable && !onActivate}
      onclick={toggle}
    >
      {#if expandable && chevron === 'leading'}<ChevronRight class="chev size-3.5 shrink-0 {open ? 'rotate-90' : ''}" />{/if}
      {@render header()}
      {#if expandable && chevron === 'trailing'}<ChevronRight class="chev size-3.5 shrink-0 {open ? 'rotate-90' : ''}" />{/if}
    </UiButton>
    {#if actions}{@render actions()}{/if}
  </div>
  {#if expandable && open && body}
    <div class="body">{@render body()}</div>
  {/if}
</div>

<style>
  .row {
    display: flex;
    min-width: 0;
    align-items: center;
  }
  :is(.head, :global(.head.ui-local-2c22291d)) {
    display: flex;
    min-width: 0;
    flex: 1;
    align-items: center;
    text-align: left;
    color: var(--muted-foreground);
    transition: color var(--motion-fast) var(--motion-ease);
  }
  :is(.head:not(:disabled):hover, :global(.head:not(:disabled):hover.ui-local-2c22291d)),
  :is(.head:focus-visible, :global(.head:focus-visible.ui-local-2c22291d)) {
    color: var(--foreground);
  }
  :is(.head:disabled, :global(.head:disabled.ui-local-2c22291d)) {
    cursor: default;
  }
  /* The chevron is a lucide component: its svg carries no scope class of ours,
     so every rule that reaches it goes through :global. */
  :is(.head, :global(.head.ui-local-2c22291d)) :global(.chev) {
    opacity: 0;
    transition: transform var(--motion-fast) var(--motion-ease), opacity var(--motion-fast) var(--motion-ease);
  }
  :is(.head:hover, :global(.head:hover.ui-local-2c22291d)) :global(.chev),
  :is(.head:focus-visible, :global(.head:focus-visible.ui-local-2c22291d)) :global(.chev),
  :global(.head[aria-expanded='true'].ui-local-2c22291d) :global(.chev) {
    opacity: 1;
  }
  /* A block and a subagent are structural: their chevron is always in view. */
  .level-block :global(.chev),
  .level-subagent :global(.chev) {
    opacity: 0.55;
  }
  .level-block :is(.head:hover, :global(.head:hover.ui-local-2c22291d)) :global(.chev),
  .level-block :is(.head:focus-visible, :global(.head:focus-visible.ui-local-2c22291d)) :global(.chev),
  .level-block :global(.head[aria-expanded='true'].ui-local-2c22291d) :global(.chev),
  .level-subagent :is(.head:hover, :global(.head:hover.ui-local-2c22291d)) :global(.chev),
  .level-subagent :is(.head:focus-visible, :global(.head:focus-visible.ui-local-2c22291d)) :global(.chev),
  .level-subagent :global(.head[aria-expanded='true'].ui-local-2c22291d) :global(.chev) {
    opacity: 1;
  }
  /* ── L1: the run of work between two pieces of prose ─────────────────── */
  /* A header, not a row: smaller and dimmer than everything it holds. */
  .level-block > .row > :global(.head.ui-local-2c22291d) {
    gap: 0.375rem;
    padding: 0.3125rem 0.5rem;
    border-radius: 0.5rem;
    font-size: var(--text-xs);
  }
  /* Its rows hang from a hairline under the chevron, and keep `--row-gap`
     between them: at 0 a run of steps read as one paragraph, while the blocks
     around them breathe at `--thread-gap`. */
  .level-block > .body {
    display: flex;
    flex-direction: column;
    gap: var(--row-gap, 2px);
    margin-left: 0.9375rem;
    padding-left: 0.25rem;
    border-left: 1px solid var(--border-subtle);
  }

  /* ── L2: one tool call ───────────────────────────────────────────────── */
  .level-step > .row > :global(.head.ui-local-2c22291d) {
    gap: 0.5rem;
    padding: 0.3125rem 0.5rem;
    border-radius: 0.5rem;
    font-size: var(--text-sm);
  }
  .level-step > .body {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.5rem 0.5rem 0.5rem var(--step-body-indent, 1.875rem);
  }

  /* ── L2: a subagent, which is an agent and not a call ────────────────── */
  .level-subagent > .row > :global(.head.ui-local-2c22291d) {
    gap: 0.5rem;
    padding: 0.375rem 0.5rem;
    border-radius: 0.5rem;
    font-size: var(--text-sm);
  }
  /* One indent deeper than a step, behind its own rail, and its rows tuck in
     closer so three levels still fit a narrow window. */
  .level-subagent > .body {
    --step-body-indent: 0.875rem;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    margin-left: 0.75rem;
    padding: 0.125rem 0.375rem 0.375rem 0.5rem;
    border-left: 1px solid var(--border-subtle);
  }

  /* ── a card: one child of a run, drawn as its own object ────────────── */
  /*
   * No box. A child sits inside a block that already draws a rail, and a second
   * boundary two levels down reads as noise — the three rows and the space
   * around them are what tell one child from the next.
   */
  .disclosure.is-card {
    margin-block: 0.375rem;
    padding: 0.125rem 0.5rem;
  }
  /* The action column sits a step away from the cost that ends the head line,
     or the two read as one control. */
  .disclosure.is-card > .row {
    align-items: flex-start;
    gap: 0.5rem;
  }
  /* The action column and the head are one line of the card's own column. */
  .disclosure.is-card > .row > :global(.head.ui-local-2c22291d) {
    padding: 0;
    border-radius: 0;
  }
  .disclosure.is-card > .body {
    margin-left: 0;
    padding: 0.375rem 0 0.125rem;
    border-left: 0;
  }

  /* ── Lq: what the model thought, the quietest row on the page ────────── */
  .level-thought > .row > :global(.head.ui-local-2c22291d) {
    gap: 0.5rem;
    padding: 0.3125rem 0.5rem;
    border-radius: 0.5rem;
    font-size: var(--text-code);
    opacity: 0.85;
  }
  .level-thought > .body {
    margin: 0.125rem 0 0.375rem 0.5rem;
    padding: 0.125rem 0.5rem 0.125rem 0.75rem;
    border-left: 1px solid var(--border-subtle);
    font-size: var(--text-sm);
    line-height: 1.6;
  }
</style>

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
  import type { Snippet } from 'svelte';
  import { ChevronRight } from 'lucide-svelte';
  import { disclosure } from './disclosure.svelte';

  let {
    id,
    level = 'step',
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

<div class="disclosure level-{level}">
  <div class="row">
    <button
      type="button"
      class="head"
      aria-expanded={expandable ? open : undefined}
      disabled={!expandable && !onActivate}
      onclick={toggle}
    >
      {#if expandable && chevron === 'leading'}<ChevronRight class="chev size-3.5 shrink-0 {open ? 'rotate-90' : ''}" />{/if}
      {@render header()}
      {#if expandable && chevron === 'trailing'}<ChevronRight class="chev size-3.5 shrink-0 {open ? 'rotate-90' : ''}" />{/if}
    </button>
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
  .head {
    display: flex;
    min-width: 0;
    flex: 1;
    align-items: center;
    text-align: left;
    color: var(--muted-foreground);
    transition: color var(--motion-fast) var(--motion-ease);
  }
  .head:not(:disabled):hover,
  .head:focus-visible {
    color: var(--foreground);
  }
  .head:disabled {
    cursor: default;
  }
  /* The chevron is a lucide component: its svg carries no scope class of ours,
     so every rule that reaches it goes through :global. */
  .head :global(.chev) {
    opacity: 0;
    transition: transform var(--motion-fast) var(--motion-ease), opacity var(--motion-fast) var(--motion-ease);
  }
  .head:hover :global(.chev),
  .head:focus-visible :global(.chev),
  .head[aria-expanded='true'] :global(.chev) {
    opacity: 1;
  }
  /* A block and a subagent are structural: their chevron is always in view. */
  .level-block :global(.chev),
  .level-subagent :global(.chev) {
    opacity: 0.55;
  }
  .level-block .head:hover :global(.chev),
  .level-block .head:focus-visible :global(.chev),
  .level-block .head[aria-expanded='true'] :global(.chev),
  .level-subagent .head:hover :global(.chev),
  .level-subagent .head:focus-visible :global(.chev),
  .level-subagent .head[aria-expanded='true'] :global(.chev) {
    opacity: 1;
  }
  /* ── L1: the run of work between two pieces of prose ─────────────────── */
  /* A header, not a row: smaller and dimmer than everything it holds. */
  .level-block > .row > .head {
    gap: 0.375rem;
    padding: 0.3125rem 0.5rem;
    border-radius: 0.5rem;
    font-size: var(--text-xs);
  }
  /* Its rows hang from a hairline under the chevron. */
  .level-block > .body {
    display: flex;
    flex-direction: column;
    margin-left: 0.9375rem;
    padding-left: 0.25rem;
    border-left: 1px solid var(--border-subtle);
  }

  /* ── L2: one tool call ───────────────────────────────────────────────── */
  .level-step > .row > .head {
    gap: 0.5rem;
    padding: 0.3125rem 0.5rem;
    border-radius: 0.5rem;
    font-size: var(--text-sm);
  }
  .level-step > .body {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.25rem 0.5rem 0.625rem var(--step-body-indent, 1.875rem);
  }

  /* ── L2: a subagent, which is an agent and not a call ────────────────── */
  .level-subagent > .row > .head {
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

  /* ── Lq: what the model thought, the quietest row on the page ────────── */
  .level-thought > .row > .head {
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

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
  Callers choose the initial state; the reader's choice always wins.
-->

<script lang="ts">
  import UiButton from '$lib/components/ui/Button.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import type { Snippet } from 'svelte';
  import { ChevronRight } from '$lib/icons';
  import { disclosure } from './disclosure-state.svelte';

  let {
    id,
    level = 'step',
    chevron = 'trailing',
    defaultOpen = false,
    disabled = false,
    kind,
    running = false,
    onActivate,
    bare = false,
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
    /** Semantic kind of step (read, search, edit, command, thought, etc.) for layout themes. */
    kind?: string;
    /** True while this step is actively executing. */
    running?: boolean;
    /** A row that acts instead of opening (a presented plan opens the dock). */
    onActivate?: () => void;
    /** Only the body, always shown: a work layout drew the row itself and
        opens this for its detail (the diff, the command's output). */
    bare?: boolean;
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

{#if bare}
  {#if body && !disabled}<div class="disclosure-bare">{@render body()}</div>{/if}
{:else}
<div class="disclosure level-{level}" data-step-kind={kind} data-step-running={running ? 'true' : undefined}>
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
{/if}

<style>
  .disclosure-bare {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.375rem 0 0.5rem;
  }
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
    transition: color var(--motion-instant) var(--motion-ease);
  }
  :is(.head:not(:disabled):hover, :global(.head:not(:disabled):hover.ui-local-2c22291d)),
  :is(.head:focus-visible, :global(.head:focus-visible.ui-local-2c22291d)) {
    color: var(--foreground);
  }
  /* A step with nothing to open is finished, not unavailable: it keeps its
     siblings' strength instead of the shared button's half-faded disabled look. */
  :is(.head:disabled, :global(.head:disabled.ui-local-2c22291d)) {
    cursor: default;
    opacity: 1;
  }
  /* The chevron is an icon component: its svg carries no scope class of ours,
     so every rule that reaches it goes through :global. */
  :is(.head, :global(.head.ui-local-2c22291d)) :global(.chev) {
    opacity: 0.75;
    transition: transform var(--motion-fast) var(--motion-ease-out), opacity var(--motion-instant) var(--motion-ease);
  }
  :is(.head:hover, :global(.head:hover.ui-local-2c22291d)) :global(.chev),
  :is(.head:focus-visible, :global(.head:focus-visible.ui-local-2c22291d)) :global(.chev),
  :global(.head[aria-expanded='true'].ui-local-2c22291d) :global(.chev) {
    opacity: 1;
  }
  /* A block and a subagent are structural: their chevron is always in view. */
  .level-block :global(.chev),
  .level-subagent :global(.chev) {
    opacity: 0.75;
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
  /* A header, not a row: dimmer than everything it holds, at the rows' size so
     the block reads as one column of type (at --text-xs it looked like a stray
     caption above its own rows). */
  .level-block > .row > :global(.head.ui-local-2c22291d) {
    gap: 0.375rem;
    padding: 0.3125rem 0.5rem;
    border-radius: 0.5rem;
    font-size: var(--text-sm);
  }
  /* Its rows hang from a hairline under the chevron, and keep `--row-gap`
     between them: at 0 a run of steps read as one paragraph, while the blocks
     around them breathe at `--thread-gap`. */
  .level-block > .body {
    display: flex;
    flex-direction: var(--block-body-direction, column);
    flex-wrap: var(--block-body-wrap, nowrap);
    align-items: var(--block-body-align, stretch);
    gap: var(--block-body-gap, var(--row-gap, 2px));
    margin-left: var(--block-body-ml, 0.9375rem);
    padding-left: var(--block-body-pl, 0.25rem);
    padding-top: var(--block-body-pt, 0);
    border-left: var(--block-body-bl, 1px solid var(--border-subtle));
  }

  /* ── L2: one tool call ───────────────────────────────────────────────── */
  .level-step > .row > :global(.head.ui-local-2c22291d) {
    gap: var(--step-head-gap, 0.5rem);
    padding: var(--step-head-padding, 0.3125rem 0.5rem);
    border-radius: var(--step-head-radius, 0.5rem);
    font-size: var(--step-head-font-size, var(--text-sm));
    min-height: var(--step-head-min-h, 0);
  }
  .level-step > .body {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: var(--step-body-padding, 0.5rem 0.5rem 0.5rem var(--step-body-indent, 1.875rem));
    border-top: var(--step-body-bt, 0);
  }

  /* ── L2: a subagent, which is an agent and not a call ────────────────── */
  .level-subagent > .row > :global(.head.ui-local-2c22291d) {
    gap: 0.5rem;
    padding: var(--subagent-head-padding, 0.375rem 0.5rem);
    border-radius: var(--subagent-head-radius, 0.5rem);
    font-size: var(--text-sm);
    min-height: var(--subagent-head-min-h, 0);
  }
  /* One indent deeper than a step, behind its own rail, and its rows tuck in
     closer so three levels still fit a narrow window. Reset `--step-*` so
     outer layout overrides never leak into nested subagent tool steps. */
  .level-subagent > .body {
    --step-body-indent: 0.875rem;
    --step-head-gap: 0.5rem;
    --step-head-padding: 0.3125rem 0.5rem;
    --step-head-radius: 0.5rem;
    --step-head-font-size: var(--text-sm);
    --step-head-min-h: 0;
    --step-body-padding: 0.5rem 0.5rem 0.5rem 0.875rem;
    --step-body-bt: 0;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    margin-left: var(--subagent-body-ml, 0.75rem);
    padding: var(--subagent-body-padding, 0.125rem 0.375rem 0.375rem 0.5rem);
    border-left: var(--subagent-body-bl, 1px solid var(--border-subtle));
    border-top: var(--subagent-body-bt, 0);
  }

  /* ── Lq: what the model thought, the quietest row on the page ────────── */
  .level-thought > .row > :global(.head.ui-local-2c22291d) {
    gap: var(--thought-head-gap, 0.5rem);
    padding: var(--thought-head-padding, 0.3125rem 0.5rem);
    border-radius: var(--thought-head-radius, 0.5rem);
    font-size: var(--text-code);
    min-height: var(--thought-head-min-h, 0);
  }
  .level-thought > .body {
    margin: var(--thought-body-margin, 0.125rem 0 0.375rem 0.5rem);
    padding: var(--thought-body-padding, 0.125rem 0.5rem 0.125rem 0.75rem);
    border-left: var(--thought-body-bl, 1px solid var(--border-subtle));
    border-top: var(--thought-body-bt, 0);
    font-size: var(--text-sm);
    line-height: 1.6;
  }
</style>

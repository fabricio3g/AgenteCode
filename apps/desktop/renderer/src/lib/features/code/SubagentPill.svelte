<svelte:options runes={true} />

<!--
  The conversation's subagents, in one line over the composer: how many there
  are and how many are still working. This is their one place — the transcript
  draws no subagent rows. Hovering or focusing the pill lifts a plain list
  above it (the transcript never moves): one line per child, a status dot, its
  task, then what it is doing and for how long. A row opens the child in the
  Subagent pane.

  Keys: Enter/Space on the pill pins the list open, ↑↓ move between rows,
  Escape closes and hands focus back to the pill.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { ChevronUp } from '$lib/icons';
  import type { ChatSession } from '$lib/types/chat';
  import SubagentTally from './SubagentTally.svelte';
  import { copy } from '$lib/copy';
  import { formatToolDuration, titleCaseToolName } from '$lib/utils/tool-ui';
  import { codeStore } from './code.svelte';
  import { childActivity, childElapsedMs, sessionChildren } from './subagent-row';
  import { subagentFocus } from './subagent-focus.svelte';

  let { chat }: { chat: ChatSession } = $props();

  const run = $derived(codeStore.runFor(chat.id));
  const children = $derived(sessionChildren(chat.messages, run?.children ?? []));
  const working = $derived(children.filter((child) => child.status === 'running').length);

  let hovered = $state(false);
  let pinned = $state(false);
  let focusInside = $state(false);
  const open = $derived(hovered || pinned || focusInside);
  let leaveTimer: ReturnType<typeof setTimeout> | undefined;
  let root = $state<HTMLElement>();
  let summary = $state<HTMLButtonElement>();

  let now = $state(Date.now());
  $effect(() => {
    if (!working) return;
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  function enter() { clearTimeout(leaveTimer); hovered = true; }
  // A short grace, so the pointer can cross the gap between pill and list.
  function leave() { leaveTimer = setTimeout(() => (hovered = false), 160); }

  function pick(id: string) {
    subagentFocus.open(chat.id, id);
    pinned = false;
    hovered = false;
    // Focus goes back to the pill for the keyboard, but the list folds.
    summary?.focus();
    focusInside = false;
  }

  function onKeydown(event: KeyboardEvent) {
    const rows = [...(root?.querySelectorAll<HTMLButtonElement>('[data-subagent-pick]') ?? [])];
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      pinned = false;
      hovered = false;
      summary?.focus();
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      if (!rows.length) return;
      event.preventDefault();
      pinned = true;
      // The list sits above the pill, so Up from the pill enters at the bottom.
      const next = index < 0 ? rows.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      rows[next]?.focus();
    }
  }
</script>

{#if children.length}
  <div class="composer-column subagent-dock px-3 md:px-6">
    <!-- svelte-ignore a11y_no_static_element_interactions (hover only previews; the button and rows carry the keys) -->
    <div class="pill-wrap" bind:this={root} onmouseenter={enter} onmouseleave={leave} onkeydown={onKeydown}
      onfocusin={() => (focusInside = true)} onfocusout={(event) => { if (!root?.contains(event.relatedTarget as Node)) focusInside = false; }}>
      {#if open}
        <ul class="list" aria-label={$t('sessionHud.subagents')}>
          {#each children as child (child.id)}
            {@const elapsed = childElapsedMs(child, now)}
            <li>
              <button type="button" class="row" data-subagent-pick={child.id} class:is-active={subagentFocus.get(chat.id) === child.id}
                title={`${titleCaseToolName(child.kind)} · ${child.description}`} onclick={() => pick(child.id)}>
                <span class="dot" data-state={child.status} aria-hidden="true"></span>
                <span class="title">{child.description || titleCaseToolName(child.kind)}</span>
                <span class="aside" class:text-error={child.status === 'error'}>
                  {#if child.status === 'running'}<span class="ui-shimmer-text">{childActivity(child) ?? copy.status.working}</span>
                  {:else if child.status === 'error'}{copy.tool.failed}{/if}
                  {#if elapsed !== undefined}<span class="elapsed">{formatToolDuration(elapsed)}</span>{/if}
                </span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
      <button type="button" class="pill" bind:this={summary} aria-expanded={open} data-subagent-pill
        onclick={() => (pinned = !pinned)}>
        <SubagentTally {children} stopping={!!run?.stopping} />
        <ChevronUp class="chevron size-3.5" />
      </button>
    </div>
  </div>
{/if}

<style>
  .subagent-dock { position: relative; z-index: 6; margin-bottom: 0.375rem; }
  /* Starts on the composer content's left edge, like the approval bar. */
  .pill-wrap { position: relative; display: inline-flex; padding-left: 1.125rem; }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    height: 1.75rem;
    padding: 0 0.625rem;
    border: 0;
    border-radius: var(--radius-full);
    background: color-mix(in srgb, var(--foreground) 6%, transparent);
    color: var(--muted-foreground);
    font: inherit;
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    transition: background-color var(--motion-instant) var(--motion-ease);
  }
  .pill:hover, .pill[aria-expanded='true'] { background: color-mix(in srgb, var(--foreground) 10%, transparent); }
  .pill:focus-visible { outline: 2px solid var(--brand-accent); outline-offset: 2px; }
  .pill :global(.chevron) { opacity: 0.6; transition: transform var(--motion-fast) var(--motion-ease); }
  .pill[aria-expanded='false'] :global(.chevron) { transform: rotate(180deg); }

  /* Lifts above the pill: the transcript under it never shifts. */
  .list {
    position: absolute;
    bottom: calc(100% + 0.375rem);
    left: 1.125rem;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    width: min(24rem, calc(100vw - 4rem));
    max-height: min(50vh, 22rem);
    margin: 0;
    padding: 0.375rem;
    overflow-y: auto;
    list-style: none;
    border-radius: var(--radius-lg);
    background: var(--popover, var(--background));
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--foreground) 8%, transparent), 0 10px 28px -12px rgb(0 0 0 / 0.4);
    transform-origin: bottom left;
    animation: list-in var(--motion-fast) var(--motion-ease-out);
  }
  /* One line per child: dot, task, then status and time on the right edge. */
  .row {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 0.625rem;
    height: 2rem;
    padding: 0 0.625rem;
    border: 0;
    border-radius: var(--float-row-radius);
    background: none;
    color: var(--foreground);
    font: inherit;
    font-size: var(--text-sm);
    text-align: left;
    cursor: pointer;
    transition: background-color var(--motion-instant) var(--motion-ease);
  }
  .row:hover, .row:focus-visible, .row.is-active { background: var(--float-row-hover); outline: none; }
  .dot { width: 0.4375rem; height: 0.4375rem; flex-shrink: 0; border-radius: var(--radius-full); background: color-mix(in srgb, var(--muted-foreground) 70%, transparent); }
  .dot[data-state='running'] { background: var(--brand-accent); }
  .dot[data-state='error'] { background: var(--destructive); }
  .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .aside { display: inline-flex; flex-shrink: 0; gap: 0.5rem; color: var(--muted-foreground); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  .elapsed { min-width: 3.25rem; text-align: right; }
  @keyframes list-in { from { opacity: 0; transform: translateY(4px) scale(0.98); } }
</style>

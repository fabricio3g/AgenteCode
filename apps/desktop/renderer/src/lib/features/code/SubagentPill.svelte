<svelte:options runes={true} />

<!--
  The active run's subagents, in one line over the composer. Settled runs
  are available from the transcript. Hovering or focusing the pill lifts a list
  above it (the transcript never moves): one line per child, a status dot, its
  task, then what it is doing and for how long. A row opens the child in the
  Subagent pane.

  Keys: Enter/Space on the pill pins the list open, ↑↓ move between rows,
  Escape closes and hands focus back to the pill.
-->

<script lang="ts">
  import Button from '$lib/components/ui/Button.svelte';
  import { onDestroy, tick } from 'svelte';
  import { t } from 'svelte-i18n';
  import { ChevronUp } from '$lib/icons';
  import type { ChatSession } from '$lib/types/chat';
  import SubagentTally from './SubagentTally.svelte';
  import { copy } from '$lib/copy';
  import { formatToolDuration, titleCaseToolName } from '$lib/utils/tool-ui';
  import { codeStore } from './code.svelte';
  import { childActivity, childElapsedMs, composerChildren } from './subagent-row';
  import { subagentFocus } from './subagent-focus.svelte';
  import { codeErrorSummaryKey } from './code-error';

  let { chat }: { chat: ChatSession } = $props();

  const run = $derived(codeStore.runFor(chat.id));
  const children = $derived(composerChildren(run, chat.messages));
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
  $effect.pre(() => {
    const focused = document.activeElement;
    const hadFocus = root?.contains(focused);
    if (!children.length) {
      if (hadFocus) window.dispatchEvent(new Event('focus-composer'));
      resetList();
    } else if (hadFocus) {
      const childId = focused?.getAttribute('data-subagent-pick');
      if (childId && !children.some((child) => child.id === childId)) summary?.focus();
    }
  });
  onDestroy(() => clearTimeout(leaveTimer));

  function enter() { clearTimeout(leaveTimer); hovered = true; }
  // A short grace, so the pointer can cross the gap between pill and list.
  function leave() { leaveTimer = setTimeout(() => (hovered = false), 160); }

  function resetList() {
    clearTimeout(leaveTimer);
    pinned = false;
    hovered = false;
    focusInside = false;
  }

  function closeList() {
    summary?.focus();
    resetList();
  }

  function pick(id: string) {
    subagentFocus.open(chat.id, id);
    closeList();
  }

  async function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      closeList();
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      pinned = true;
      await tick();
      if (!open) return;
      const rows = [...(root?.querySelectorAll<HTMLButtonElement>('[data-subagent-pick]') ?? [])];
      if (!rows.length) return;
      const index = rows.indexOf(document.activeElement as HTMLButtonElement);
      const down = event.key === 'ArrowDown';
      const next = index < 0 ? (down ? 0 : rows.length - 1) : (index + (down ? 1 : -1) + rows.length) % rows.length;
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
            {@const failure = child.status === 'error' && (child.summary || child.text)}
            {@const task = child.description || titleCaseToolName(child.kind)}
            <li>
              <Button variant="plain" type="button" class="row {subagentFocus.get(chat.id) === child.id ? 'is-active' : ''} ui-local-034c360f" data-subagent-pick={child.id}
                title={failure ? `${task} · ${$t(codeErrorSummaryKey(failure))}` : task} onclick={() => pick(child.id)}>
                <span class="dot" data-state={child.status} aria-hidden="true"></span>
                <span class="title">{task}</span>
                <span class="aside" class:text-error={child.status === 'error'}>
                  {#if child.status === 'running'}<span class="ui-shimmer-text">{childActivity(child) ?? copy.status.working}</span>
                  {:else if child.status === 'error'}{copy.tool.failed}{/if}
                  {#if elapsed !== undefined}<span class="elapsed">{formatToolDuration(elapsed)}</span>{/if}
                </span>
              </Button>
            </li>
          {/each}
        </ul>
      {/if}
      <Button variant="plain" type="button" class="pill ui-local-034c360f" bind:ref={summary} aria-expanded={open} data-subagent-pill
        onclick={() => { if (pinned) closeList(); else pinned = true; }}>
        <SubagentTally {children} stopping={!!run?.stopping} />
        <ChevronUp class="chevron size-3.5" />
      </Button>
    </div>
  </div>
{/if}

<style>
  .subagent-dock { position: relative; z-index: 6; margin-bottom: 0.375rem; }
  /* Starts on the composer content's left edge, like the approval bar. */
  .pill-wrap { position: relative; display: inline-flex; padding-left: 1.125rem; }
  :global(.pill.ui-local-034c360f){
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
  :global(.pill.ui-local-034c360f:hover), :global(.pill.ui-local-034c360f[aria-expanded='true']){ background: color-mix(in srgb, var(--foreground) 10%, transparent); }
  :global(.pill.ui-local-034c360f:focus-visible){ outline: 2px solid var(--brand-accent); outline-offset: 2px; }
  :global(.pill.ui-local-034c360f) :global(.chevron){ opacity: 0.6; transition: transform var(--motion-fast) var(--motion-ease); }
  :global(.pill.ui-local-034c360f[aria-expanded='false']) :global(.chevron){ transform: rotate(180deg); }

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
  :global(.row.ui-local-034c360f){
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
  :global(.row.ui-local-034c360f:hover), :global(.row.ui-local-034c360f:focus-visible), :global(.row.ui-local-034c360f.is-active){ background: var(--float-row-hover); outline: none; }
  .dot { width: 0.4375rem; height: 0.4375rem; flex-shrink: 0; border-radius: var(--radius-full); background: color-mix(in srgb, var(--muted-foreground) 70%, transparent); }
  .dot[data-state='running'] { background: var(--brand-accent); }
  .dot[data-state='error'] { background: var(--destructive); }
  .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .aside { display: inline-flex; flex-shrink: 0; gap: 0.5rem; color: var(--muted-foreground); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  .elapsed { min-width: 3.25rem; text-align: right; }
  @keyframes list-in { from { opacity: 0; transform: translateY(4px) scale(0.98); } }
</style>

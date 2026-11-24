<svelte:options runes={true} />

<!--
  Redesigned todo list, docked in the main chat column above the composer.
  Adapts automatically to `data-agent-style` (Settings → Appearance → Agent activity).
-->

<script lang="ts">
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import { ChevronDown, ChevronUp } from '$lib/icons';
  import type { ChatSession } from '$lib/types/chat';
  import { codeStore } from './code.svelte';

  let { chat }: { chat: ChatSession } = $props();

  const todos = $derived(codeStore.todosFor(chat));
  const run = $derived(codeStore.runFor(chat.id));
  const running = $derived(run?.running && !run.stopping);
  const done = $derived(todos.filter((todo) => todo.status === 'completed').length);
  const total = $derived(todos.filter((todo) => todo.status !== 'cancelled').length);
  const allDone = $derived(total > 0 && done >= total);
  const activeTodo = $derived(todos.find((todo) => todo.status === 'in_progress') ?? todos.find((todo) => todo.status === 'pending') ?? null);
  const pct = $derived(total > 0 ? Math.round((done / total) * 100) : 0);

  // Expanded while work is in progress; users can fold or unfold at any time.
  let expanded = $state(true);

  let known = new Set<string>(untrack(() => todos.filter((todo) => todo.status === 'completed').map((todo) => todo.content)));
  let fresh = $state<Record<string, true>>({});
  $effect(() => {
    for (const todo of todos) {
      if (todo.status !== 'completed' || known.has(todo.content)) continue;
      known.add(todo.content);
      fresh[todo.content] = true;
      const content = todo.content;
      setTimeout(() => { delete fresh[content]; }, 900);
    }
  });
</script>

{#if todos.length}
  <section class="todo-dock" class:is-complete={allDone} class:is-expanded={expanded} aria-label={$t('code.todosTitle')} data-chat-todos={chat.id}>
    <button type="button" class="todo-head" aria-expanded={expanded} onclick={() => (expanded = !expanded)}>
      <span class="todo-ring-wrap" aria-hidden="true">
        <svg class="todo-ring" viewBox="0 0 18 18">
          <circle class="todo-ring-bg" cx="9" cy="9" r="6.5" />
          <circle class="todo-ring-fg" cx="9" cy="9" r="6.5" style:stroke-dashoffset={40.84 * (1 - (total ? done / total : 0))} />
        </svg>
      </span>

      <span class="todo-head-copy">
        <span class="todo-head-title">{$t('code.todosTitle')}</span>
        {#if !expanded && activeTodo}
          <span class="todo-head-sep" aria-hidden="true">·</span>
          <span class="todo-head-current" class:is-live={activeTodo.status === 'in_progress' && running}>{activeTodo.content}</span>
        {/if}
      </span>

      {#if total}
        <span class="todo-head-count" aria-hidden="true">{done}/{total}</span>
      {/if}

      <span class="todo-head-chevron" aria-hidden="true">
        {#if expanded}<ChevronDown class="size-3.5" />{:else}<ChevronUp class="size-3.5" />{/if}
      </span>
    </button>

    {#if total}
      <div class="todo-progress" role="progressbar" aria-label={$t('code.todosTitle')} aria-valuemin="0" aria-valuemax={total} aria-valuenow={done}>
        <span style:width={`${pct}%`}></span>
      </div>
    {/if}

    {#if expanded}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (The task list needs focus for keyboard scrolling.) -->
      <ul class="todo-list" tabindex="0">
        {#each todos as todo, index (index)}
          {@const active = todo.status === 'in_progress'}
          {@const completed = todo.status === 'completed'}
          {@const cancelled = todo.status === 'cancelled'}
          <li class:is-active={active} class:is-done={completed} class:is-cancelled={cancelled} title={$t(`code.todoStatus.${todo.status}`)}>
            <span class="todo-mark" aria-hidden="true">
              {#if completed}
                <svg class="todo-check" class:is-fresh={fresh[todo.content]} viewBox="0 0 16 16">
                  <path class="todo-check-tick" d="M3.5 8.4 6.5 11.4 12.5 5" />
                </svg>
              {:else if active && running}
                <span class="todo-spinner"></span>
              {:else if active}
                <span class="todo-active-dot"></span>
              {:else if cancelled}
                <svg class="todo-cancel" viewBox="0 0 16 16"><path d="M4.5 4.5l7 7m0-7-7 7" /></svg>
              {:else}
                <span class="todo-pending-dot"></span>
              {/if}
            </span>
            <span class="todo-label">{todo.content}</span>
            <span class="sr-only">{$t(`code.todoStatus.${todo.status}`)}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<style>
  .todo-dock {
    position: relative;
    overflow: hidden;
    border-radius: 0.75rem;
    border: 1px solid color-mix(in srgb, var(--foreground) 7%, transparent);
    background: color-mix(in srgb, var(--card) 68%, transparent);
    transition: border-color var(--motion-fast) var(--motion-ease), background-color var(--motion-fast) var(--motion-ease);
  }
  .todo-dock:hover {
    border-color: color-mix(in srgb, var(--foreground) 12%, transparent);
  }

  .todo-head {
    display: flex;
    width: 100%;
    min-width: 0;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4375rem 0.75rem;
    border: 0;
    background: transparent;
    color: var(--muted-foreground);
    font: inherit;
    font-size: var(--text-xs);
    text-align: left;
    cursor: pointer;
    transition: background-color var(--motion-instant) var(--motion-ease), color var(--motion-instant) var(--motion-ease);
  }
  .todo-head:hover {
    background: color-mix(in srgb, var(--foreground) 3%, transparent);
    color: var(--foreground);
  }

  .todo-ring-wrap { display: inline-flex; flex-shrink: 0; align-items: center; justify-content: center; }
  .todo-ring { width: 0.9375rem; height: 0.9375rem; transform: rotate(-90deg); display: block; }
  .todo-ring-bg { fill: none; stroke: color-mix(in srgb, var(--foreground) 14%, transparent); stroke-width: 1.8; }
  .todo-ring-fg {
    fill: none;
    stroke: var(--brand-accent);
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-dasharray: 40.84;
    transition: stroke-dashoffset var(--motion-smooth) var(--motion-ease-out);
  }
  .todo-dock.is-complete .todo-ring-fg { stroke: var(--success, var(--muted-foreground)); }

  .todo-head-copy { display: flex; flex: 1; min-width: 0; align-items: baseline; gap: 0.375rem; }
  .todo-head-title { flex-shrink: 0; font-weight: 550; color: var(--foreground); }
  .todo-head-sep { flex-shrink: 0; opacity: 0.4; }
  .todo-head-current { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted-foreground); }
  .todo-head-current.is-live { color: var(--foreground); }
  .todo-head-count { flex-shrink: 0; font-variant-numeric: tabular-nums; color: var(--muted-foreground); opacity: 0.85; }
  .todo-head-chevron { display: inline-flex; flex-shrink: 0; align-items: center; opacity: 0.65; }

  .todo-progress {
    height: 1.5px;
    margin: 0 0.75rem;
    border-radius: var(--radius-full);
    background: color-mix(in srgb, var(--foreground) 6%, transparent);
    overflow: hidden;
  }
  .todo-dock:not(.is-expanded) .todo-progress {
    margin: 0 0.75rem 0.375rem;
  }
  .todo-progress span {
    display: block;
    height: 100%;
    background: var(--brand-accent);
    opacity: 0.75;
    transition: width var(--motion-smooth) var(--motion-ease-out);
  }
  .todo-dock.is-complete .todo-progress span {
    background: var(--success, var(--muted-foreground));
    opacity: 0.65;
  }

  .todo-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
    max-height: min(9rem, 24vh);
    overflow-y: auto;
    margin: 0;
    padding: 0.75rem 0.375rem;
    list-style: none;
    scrollbar-width: thin;
    mask-image: linear-gradient(to bottom, transparent 0%, #000 0.75rem, #000 calc(100% - 0.75rem), transparent 100%);
    -webkit-mask-image: linear-gradient(to bottom, transparent 0%, #000 0.75rem, #000 calc(100% - 0.75rem), transparent 100%);
  }

  li {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.25rem 0.4375rem;
    border-radius: 0.4375rem;
    font-size: var(--text-xs);
    line-height: 1.45;
    color: var(--muted-foreground);
    transition: background-color var(--motion-instant) var(--motion-ease), color var(--motion-instant) var(--motion-ease);
  }
  li.is-active {
    background: color-mix(in srgb, var(--brand-accent) 9%, transparent);
    color: var(--foreground);
    font-weight: 500;
  }
  li.is-done { color: var(--muted-foreground); opacity: 0.58; }
  li.is-done .todo-label { text-decoration: line-through; text-decoration-color: color-mix(in srgb, currentColor 45%, transparent); }
  li.is-cancelled { opacity: 0.45; }
  li.is-cancelled .todo-label { text-decoration: line-through; }

  .todo-label { min-width: 0; flex: 1; overflow-wrap: anywhere; }

  .todo-mark { display: flex; width: 0.875rem; height: 1.45em; flex-shrink: 0; align-items: center; justify-content: center; }
  .todo-check, .todo-cancel { width: 0.8125rem; height: 0.8125rem; overflow: visible; }
  .todo-check-tick { fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
  .todo-cancel path { fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; }
  .todo-check.is-fresh { animation: todo-pop var(--motion-smooth) var(--motion-ease-out); }
  .todo-check.is-fresh .todo-check-tick { stroke-dasharray: 14; stroke-dashoffset: 14; animation: todo-draw var(--motion-fast) 60ms var(--motion-ease-out) forwards; }

  .todo-pending-dot {
    width: 0.4375rem;
    height: 0.4375rem;
    border-radius: var(--radius-full);
    border: 1.25px solid color-mix(in srgb, currentColor 45%, transparent);
  }
  .todo-active-dot {
    width: 0.4375rem;
    height: 0.4375rem;
    border-radius: var(--radius-full);
    background: var(--brand-accent);
  }
  .todo-spinner {
    display: block;
    width: 0.6875rem;
    height: 0.6875rem;
    border-radius: var(--radius-full);
    border: 1.5px solid color-mix(in srgb, var(--brand-accent) 25%, transparent);
    border-top-color: var(--brand-accent);
    animation: todo-spin 0.85s linear infinite;
  }

  @keyframes todo-spin { to { transform: rotate(360deg); } }
  @keyframes todo-pop { 0% { transform: scale(0.9); } 100% { transform: scale(1); } }
  @keyframes todo-draw { to { stroke-dashoffset: 0; } }
  @media (prefers-reduced-motion: reduce) {
    .todo-spinner { animation: none; border-top-color: color-mix(in srgb, var(--brand-accent) 65%, transparent); }
    .todo-check.is-fresh, .todo-check.is-fresh .todo-check-tick { animation: none; stroke-dashoffset: 0; }
    .todo-progress span, .todo-ring-fg { transition: none; }
  }
</style>

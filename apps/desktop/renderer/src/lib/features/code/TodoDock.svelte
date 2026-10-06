<svelte:options runes={true} />

<!--
  The model's task list, docked to the top of the composer: one line with
  the task it is on and the count; a click unfolds the whole list above it.
  Live from todo_update while a run works; after it, stays while tasks are
  left undone.
-->

<script lang="ts">
  import { untrack } from 'svelte';
  import { fly, slide } from 'svelte/transition';
  import { ChevronUp } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import type { CodeTodoItem } from '$shared/agente-protocol';
  import { currentTodo } from './work-blocks';

  let { todos, running = false }: { todos: CodeTodoItem[]; running?: boolean } = $props();

  let open = $state(false);
  const done = $derived(todos.filter((todo) => todo.status === 'completed').length);
  const current = $derived(currentTodo(todos));
  const allDone = $derived(todos.length > 0 && done === todos.length);
  const percent = $derived(todos.length ? (done / todos.length) * 100 : 0);

  /*
   * Only a task that finishes while the dock is on screen gets the check
   * animation; the ones already done when it opens just show as done.
   */
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

{#snippet mark(todo: CodeTodoItem)}
  {#if todo.status === 'completed'}
    <svg class="check" class:is-fresh={fresh[todo.content]} viewBox="0 0 16 16" aria-hidden="true">
      <circle class="check-disc" cx="8" cy="8" r="6.5" />
      <path class="check-tick" d="M5 8.2 7.1 10.3 11 6" />
    </svg>
  {:else if todo.status === 'in_progress' && running}
    <span class="spinner" aria-hidden="true"></span>
  {:else}
    <svg class="pending-indicator" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" /></svg>
  {/if}
{/snippet}

<div class="todo-dock" class:all-done={allDone}>
  <div class="todo-progress" aria-hidden="true"><span style="width:{percent}%"></span></div>
  {#if open}
    <ul class="todo-list" aria-label={$t('code.todosTitle')} transition:slide={{ duration: 160 }}>
      {#each todos as todo (todo.content)}
        <li class:is-active={todo.status === 'in_progress' && running} class:is-done={todo.status === 'completed'} class:is-fresh={fresh[todo.content]}>
          <span class="mark">{@render mark(todo)}</span>
          <span class="label min-w-0 break-words">{todo.content}</span>
        </li>
      {/each}
    </ul>
  {/if}
  <button type="button" class="todo-bar" aria-expanded={open} onclick={() => (open = !open)}>
    <span class="mark">
      {#if allDone}
        <svg class="check is-fresh" viewBox="0 0 16 16" aria-hidden="true"><circle class="check-disc" cx="8" cy="8" r="6.5" /><path class="check-tick" d="M5 8.2 7.1 10.3 11 6" /></svg>
      {:else if current}
        {@render mark(current)}
      {/if}
    </span>
    <span class="bar-label">
      {#key allDone ? 'done' : current?.content}
        <span class="bar-text" in:fly={{ y: 8, duration: 180 }}>{allDone ? $t('code.todosAllDone') : current?.content ?? ''}</span>
      {/key}
    </span>
    <span class="count tabular-nums">{done}/{todos.length}</span>
    <ChevronUp class="chev size-3.5 shrink-0 transition-transform {open ? 'rotate-180' : ''}" />
  </button>
</div>

<style>
  /* Sits on the composer's top edge: same width, slightly inset, rounded on top only. */
  .todo-dock {
    position: relative;
    margin: 0 0.75rem -1px;
    overflow: hidden;
    border: 1px solid var(--border-subtle);
    border-bottom: 0;
    border-radius: 0.75rem 0.75rem 0 0;
    background: color-mix(in srgb, var(--muted) 55%, var(--chat-bg, var(--background)));
  }
  /* A hairline that fills as tasks finish. */
  .todo-progress { position: absolute; inset: 0 0 auto; height: 2px; background: transparent; }
  .todo-progress span {
    display: block;
    height: 100%;
    background: var(--work-accent);
    transition: width 420ms cubic-bezier(0.22, 1, 0.36, 1), opacity 300ms ease;
  }
  .all-done .todo-progress span { opacity: 0.5; }

  .todo-bar {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4375rem 0.75rem 0.375rem;
    font-size: 12px;
    color: var(--muted-foreground);
    transition: color var(--motion-fast) var(--motion-ease);
  }
  .todo-bar:hover { color: var(--foreground); }
  .bar-label { position: relative; display: block; min-width: 0; flex: 1; height: 1.2em; overflow: hidden; text-align: left; line-height: 1.2; }
  .bar-text { position: absolute; inset: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--foreground); }
  .all-done .bar-text { color: var(--muted-foreground); }
  .count { flex-shrink: 0; }

  .mark { display: flex; width: 0.875rem; height: 0.875rem; flex-shrink: 0; align-items: center; justify-content: center; }
  .todo-list li .mark { margin-top: 0.1875rem; }
  .pending-indicator, .check { width: 0.875rem; height: 0.875rem; overflow: visible; }
  .pending-indicator circle { fill: none; stroke: var(--muted-foreground); stroke-width: 1.4; opacity: 0.7; }
  .check-disc { fill: var(--work-accent); stroke: none; }
  .check-tick { fill: none; stroke: var(--background); stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .check.is-fresh { animation: todo-pop 360ms cubic-bezier(0.34, 1.56, 0.64, 1); }
  .check.is-fresh .check-tick { stroke-dasharray: 10; stroke-dashoffset: 10; animation: todo-draw 300ms 120ms ease-out forwards; }

  .todo-list {
    display: flex;
    max-height: min(16rem, 35vh);
    flex-direction: column;
    gap: 0.125rem;
    overflow-y: auto;
    padding: 0.625rem 0.75rem 0.375rem;
    border-bottom: 1px solid var(--border-subtle);
  }
  .todo-list li {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    font-size: 13px;
    line-height: 1.45;
    color: var(--muted-foreground);
    transition: color 300ms ease;
  }
  .todo-list li.is-active { color: var(--foreground); font-weight: 500; }
  .todo-list li.is-done { color: color-mix(in srgb, var(--muted-foreground) 80%, transparent); }
  /* The strike draws left to right instead of appearing. */
  .label {
    background: linear-gradient(currentColor, currentColor) no-repeat 0 55% / 0% 1px;
    transition: background-size 380ms cubic-bezier(0.22, 1, 0.36, 1);
  }
  .is-done .label { background-size: 100% 1px; }
  .is-fresh .label { animation: none; }

  .spinner {
    display: block;
    width: 0.75rem;
    height: 0.75rem;
    border-radius: 9999px;
    border: 1.5px solid color-mix(in srgb, var(--work-accent) 25%, transparent);
    border-top-color: var(--work-accent);
    animation: todo-spin 0.9s linear infinite;
  }
  @keyframes todo-spin { to { transform: rotate(360deg); } }
  @keyframes todo-pop { 0% { transform: scale(0.6); } 100% { transform: scale(1); } }
  @keyframes todo-draw { to { stroke-dashoffset: 0; } }
  @media (prefers-reduced-motion: reduce) {
    .spinner { animation: none; border-top-color: color-mix(in srgb, var(--work-accent) 60%, transparent); }
    .check.is-fresh, .check.is-fresh .check-tick { animation: none; stroke-dashoffset: 0; }
    .todo-progress span, .label { transition: none; }
  }
</style>

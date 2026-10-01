<svelte:options runes={true} />

<!--
  The model's task list, docked to the top of the composer: one line with
  the task it is on and the count; a click unfolds the whole list above it.
  Live from todo_update while a run works; after it, stays while tasks are
  left undone.
-->

<script lang="ts">
  import { ChevronUp, Circle, CircleCheck } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import type { CodeTodoItem } from '$shared/agente-protocol';
  import { currentTodo } from './work-blocks';

  let { todos }: { todos: CodeTodoItem[] } = $props();

  let open = $state(false);
  const done = $derived(todos.filter((todo) => todo.status === 'completed').length);
  const current = $derived(currentTodo(todos));
  const allDone = $derived(done === todos.length);
</script>

{#snippet mark(todo: CodeTodoItem)}
  {#if todo.status === 'completed'}
    <CircleCheck class="size-3.5 shrink-0 text-foreground/60" />
  {:else if todo.status === 'in_progress'}
    <span class="spinner" aria-hidden="true"></span>
  {:else}
    <Circle class="size-3.5 shrink-0 text-muted-foreground/60" />
  {/if}
{/snippet}

<div class="todo-dock">
  {#if open}
    <ul class="todo-list" aria-label={$t('code.todosTitle')}>
      {#each todos as todo (todo.content)}
        <li class:is-active={todo.status === 'in_progress'} class:is-done={todo.status === 'completed'}>
          <span class="mt-0.5 flex">{@render mark(todo)}</span>
          <span class="min-w-0 break-words">{todo.content}</span>
        </li>
      {/each}
    </ul>
  {/if}
  <button type="button" class="todo-bar" aria-expanded={open} onclick={() => (open = !open)}>
    {#if allDone}
      <CircleCheck class="size-3.5 shrink-0 text-foreground/60" />
      <span class="min-w-0 flex-1 truncate text-left">{$t('code.todosAllDone')}</span>
    {:else if current}
      {@render mark(current)}
      <span class="min-w-0 flex-1 truncate text-left text-foreground">{current.content}</span>
    {/if}
    <span class="shrink-0 tabular-nums">{done}/{todos.length}</span>
    <ChevronUp class="size-3.5 shrink-0 transition-transform {open ? 'rotate-180' : ''}" />
  </button>
</div>

<style>
  /* Sits on the composer's top edge: same width, slightly inset, rounded on top only. */
  .todo-dock {
    margin: 0 0.75rem -1px;
    overflow: hidden;
    border: 1px solid var(--border-subtle);
    border-bottom: 0;
    border-radius: 0.75rem 0.75rem 0 0;
    background: color-mix(in srgb, var(--muted) 55%, var(--chat-bg, var(--background)));
  }
  .todo-bar {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.75rem;
    font-size: 12px;
    color: var(--muted-foreground);
    transition: color var(--motion-fast) var(--motion-ease);
  }
  .todo-bar:hover {
    color: var(--foreground);
  }
  .todo-list {
    display: flex;
    max-height: min(16rem, 35vh);
    flex-direction: column;
    gap: 0.125rem;
    overflow-y: auto;
    padding: 0.5rem 0.75rem 0.375rem;
    border-bottom: 1px solid var(--border-subtle);
  }
  .todo-list li {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--muted-foreground);
  }
  .todo-list li.is-active {
    color: var(--foreground);
    font-weight: 500;
  }
  .todo-list li.is-done {
    text-decoration: line-through;
    text-decoration-color: color-mix(in srgb, var(--muted-foreground) 55%, transparent);
  }
  .spinner {
    display: block;
    width: 0.75rem;
    height: 0.75rem;
    flex-shrink: 0;
    margin: 0.0625rem;
    border-radius: 9999px;
    border: 1.5px solid color-mix(in srgb, var(--foreground) 25%, transparent);
    border-top-color: var(--foreground);
    animation: todo-spin 0.9s linear infinite;
  }
  @keyframes todo-spin {
    to { transform: rotate(360deg); }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner { animation: none; border-top-color: color-mix(in srgb, var(--foreground) 60%, transparent); }
  }
</style>

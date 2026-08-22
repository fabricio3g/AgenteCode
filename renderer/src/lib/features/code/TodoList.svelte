<svelte:options runes={true} />

<!--
  The model-maintained task list, rendered live from todo_update events.
  Quiet rows, one accent for the in-progress item, checkmarks
  that land the moment the model marks them — progress you can read at a
  glance without opening anything.
-->

<script lang="ts">
  import { Circle, CircleCheck } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import type { CodeTodoItem } from './code-protocol';

  let { todos }: { todos: CodeTodoItem[] } = $props();

  const done = $derived(todos.filter((t) => t.status === 'completed').length);
</script>

<div class="todo-card rounded-xl border border-border bg-muted/40 px-3 py-2.5" role="list" aria-label={$t('code.todosTitle')}>
  <div class="mb-1.5 flex items-center justify-between text-[11px] font-medium text-muted-foreground">
    <span>{$t('code.todosTitle')}</span>
    <span>{done}/{todos.length}</span>
  </div>
  <ul class="flex flex-col gap-1">
    {#each todos as todo (todo.content)}
      <li
        class="flex items-start gap-2 py-0.5 text-sm leading-snug"
        class:todo-active={todo.status === 'in_progress'}
        class:todo-done={todo.status === 'completed'}
        role="listitem"
      >
        <span class="mt-0.5 shrink-0">
          {#if todo.status === 'completed'}
            <CircleCheck class="size-3.5 text-foreground/70" />
          {:else if todo.status === 'in_progress'}
            <span class="todo-spinner" aria-hidden="true"></span>
          {:else}
            <Circle class="size-3.5 text-muted-foreground/60" />
          {/if}
        </span>
        <span class="min-w-0 break-words">{todo.content}</span>
      </li>
    {/each}
  </ul>
</div>

<style>
  .todo-active {
    color: var(--foreground);
    font-weight: 500;
  }

  .todo-done {
    color: var(--muted-foreground);
    text-decoration: line-through;
    text-decoration-color: color-mix(in srgb, var(--muted-foreground) 55%, transparent);
  }

  /* The in-progress marker breathes instead of spinning loudly. */
  .todo-spinner {
    display: block;
    width: 0.55rem;
    height: 0.55rem;
    margin: 0.25rem auto;
    border-radius: 9999px;
    border: 1.5px solid color-mix(in srgb, var(--foreground) 25%, transparent);
    border-top-color: var(--foreground);
    animation: todo-spin 0.9s linear infinite;
  }

  @keyframes todo-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .todo-spinner {
      animation: none;
      border-top-color: color-mix(in srgb, var(--foreground) 60%, transparent);
    }
  }
</style>

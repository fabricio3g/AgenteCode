<svelte:options runes={true} />

<script lang="ts">
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { ChatSession } from '$lib/types/chat';
  import { codeStore } from './code.svelte';

  let { chat }: { chat: ChatSession } = $props();

  const todos = $derived(codeStore.todosFor(chat));
  const run = $derived(codeStore.runFor(chat.id));
  const running = $derived(run?.running && !run.stopping);
  const done = $derived(todos.filter((todo) => todo.status === 'completed').length);
  const total = $derived(todos.filter((todo) => todo.status !== 'cancelled').length);

  /*
   * Only a task that finishes after the panel mounts gets the check
   * animation; the ones already done when it mounts just show as done.
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

{#if todos.length}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (The task list needs focus for keyboard scrolling.) -->
  <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3" role="region" aria-label={$t('code.todosTitle')} tabindex="0">
    {#if total}
      <div class="tasks-progress">
        <div class="progress-track" role="progressbar" aria-label={$t('code.todosTitle')} aria-valuemin="0" aria-valuemax={total} aria-valuenow={done}><span style:width={`${done / total * 100}%`}></span></div>
        <span class="tabular-nums" aria-hidden="true">{done}/{total}</span>
      </div>
    {/if}
    <ul>
      {#each todos as todo, index (index)}
        {@const active = todo.status === 'in_progress'}
        <li class:is-active={active} class:is-done={todo.status === 'completed'} class:is-cancelled={todo.status === 'cancelled'} title={$t(`code.todoStatus.${todo.status}`)}>
          <span class="mark">
            {#if todo.status === 'completed'}
              <svg class="check" class:is-fresh={fresh[todo.content]} viewBox="0 0 16 16" aria-hidden="true">
                <circle class="check-ring" cx="8" cy="8" r="6.5" />
                <path class="check-tick" d="M5 8.2 7.1 10.3 11 6" />
              </svg>
            {:else if active && running}
              <span class="spinner" aria-hidden="true"></span>
            {:else if todo.status === 'cancelled'}
              <svg class="pending" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7m0-7-7 7" /></svg>
            {:else}
              <svg class="pending" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" /></svg>
            {/if}
          </span>
          <span class="label">{todo.content}</span>
          <span class="sr-only">{$t(`code.todoStatus.${todo.status}`)}</span>
        </li>
      {/each}
    </ul>
  </div>
{:else}
  <p class="p-5 text-xs text-muted-foreground">{$t('code.todosEmpty')}</p>
{/if}

<style>
  .tasks-progress {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.75rem;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
  }
  .progress-track { flex:1; height:3px; border-radius:var(--radius-full); background:var(--muted); overflow:hidden; }
  .progress-track span { display:block; height:100%; background:var(--text-secondary); transition:width var(--motion-smooth) var(--motion-ease-out); }
  ul { display:flex; flex-direction:column; gap:0.375rem; margin:0; padding:0; list-style:none; }
  li {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    font-size: var(--text-sm);
    line-height: 1.45;
    color: var(--muted-foreground);
  }
  li.is-active { color: var(--foreground); }
  li.is-cancelled { opacity:0.65; }
  .label { min-width: 0; overflow-wrap: anywhere; }
  /* The strike draws left to right instead of appearing. */
  .label {
    background: linear-gradient(currentColor, currentColor) no-repeat 0 55% / 0% 1px;
    transition: background-size var(--motion-smooth) var(--motion-ease-out);
  }
  .is-done .label { background-size: 100% 1px; }

  .mark { display: flex; width: 0.875rem; height: 1.45em; flex-shrink: 0; align-items: center; justify-content: center; }
  .pending, .check { width: 0.875rem; height: 0.875rem; overflow: visible; }
  .pending circle { fill: none; stroke: currentColor; stroke-width: 1.4; opacity: 0.7; }
  .pending path { fill:none; stroke:currentColor; stroke-width:1.4; stroke-linecap:round; }
  .check-ring { fill: none; stroke: currentColor; stroke-width: 1.3; }
  .check-tick { fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  .check.is-fresh { animation: plan-pop var(--motion-smooth) var(--motion-ease-out); }
  .check.is-fresh .check-tick { stroke-dasharray: 10; stroke-dashoffset: 10; animation: plan-draw var(--motion-fast) 80ms var(--motion-ease-out) forwards; }
  .spinner {
    display: block;
    width: 0.75rem;
    height: 0.75rem;
    border-radius: var(--radius-full);
    border: 1.5px solid color-mix(in srgb, var(--brand-accent) 25%, transparent);
    border-top-color: var(--brand-accent);
    animation: plan-spin 0.9s linear infinite;
  }

  @keyframes plan-spin { to { transform: rotate(360deg); } }
  @keyframes plan-pop { 0% { transform: scale(0.9); } 100% { transform: scale(1); } }
  @keyframes plan-draw { to { stroke-dashoffset: 0; } }
  @media (prefers-reduced-motion: reduce) {
    .spinner { animation: none; border-top-color: color-mix(in srgb, var(--brand-accent) 60%, transparent); }
    .check.is-fresh, .check.is-fresh .check-tick { animation: none; stroke-dashoffset: 0; }
    .label, .progress-track span { transition: none; }
  }
</style>

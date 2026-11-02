<svelte:options runes={true} />

<!--
  The model's task list, as a card in the reply where it last changed it (the
  way Codex draws its plan). Short lists show whole; a long one shows the step
  before the current one, the current one and the next, and folds the rest
  into "+N more". Live from todo_update while the reply streams; a saved reply
  keeps its own snapshot.
-->

<script lang="ts">
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { CodeTodoItem } from '$shared/agente-protocol';
  import UiButton from '$lib/components/ui/Button.svelte';
  import { planRows } from './work-blocks';

  let { todos, running = false, compact = false }: { todos: CodeTodoItem[]; running?: boolean; compact?: boolean } = $props();

  let open = $state(false);
  const done = $derived(todos.filter((todo) => todo.status === 'completed').length);
  const total = $derived(todos.filter((todo) => todo.status !== 'cancelled').length);
  const rows = $derived(planRows(todos, open));
  const hidden = $derived(todos.length - rows.length);

  /*
   * Only a task that finishes while the card is on screen gets the check
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

<section class="plan-card" class:compact aria-label={$t('code.todosTitle')} data-plan-card>
  <header class="plan-head">
    <span>{$t('code.todosTitle')}</span>
    <span class="tabular-nums">{done}/{total}</span>
  </header>
  <div class="plan-progress" role="progressbar" aria-label={$t('code.todosTitle')} aria-valuemin="0" aria-valuemax={total} aria-valuenow={done}><span style:width={`${total ? done / total * 100 : 0}%`}></span></div>
  <ul>
    {#each rows as todo, index (index)}
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
      </li>
    {/each}
  </ul>
  {#if hidden > 0 || open}
    <UiButton variant="plain" type="button" class="plan-more" aria-expanded={open} onclick={() => (open = !open)}>
      {open ? $t('code.todosLess') : $t('code.todosMore', { values: { n: hidden } })}
    </UiButton>
  {/if}
</section>

<style>
  .plan-card {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    padding: 0.5rem 0.75rem 0.5625rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    background: var(--card);
    font-size: var(--text-sm);
  }
  .plan-head {
    display: flex;
    justify-content: space-between;
    margin-bottom: 0.125rem;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
  }
  .plan-card.compact { padding:0.5rem 0.625rem; border:0; background:transparent; }
  .plan-progress { height:3px; border-radius:99px; background:var(--muted); overflow:hidden; margin:0.125rem 0 0.375rem; }
  .plan-progress span { display:block; height:100%; background:var(--text-secondary); transition:width var(--motion-smooth) var(--motion-ease-out); }
  ul { display: flex; flex-direction: column; gap: 0.0625rem; margin: 0; padding: 0; list-style: none; }
  li {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
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

  :global(.plan-more) {
    align-self: flex-start;
    margin-top: 0.125rem;
    padding-inline-start: 1.375rem;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
  }
  :global(.plan-more:hover) { color: var(--foreground); }

  @keyframes plan-spin { to { transform: rotate(360deg); } }
  @keyframes plan-pop { 0% { transform: scale(0.9); } 100% { transform: scale(1); } }
  @keyframes plan-draw { to { stroke-dashoffset: 0; } }
  @media (prefers-reduced-motion: reduce) {
    .spinner { animation: none; border-top-color: color-mix(in srgb, var(--brand-accent) 60%, transparent); }
    .check.is-fresh, .check.is-fresh .check-tick { animation: none; stroke-dashoffset: 0; }
    .label, .plan-progress span { transition: none; }
  }
</style>

<script lang="ts">
  import { Pause, Play, Target } from '$lib/icons';
  import Button from '$lib/components/ui/Button.svelte';
  import Dialog from '$lib/components/ui/Dialog.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';
  import { invoke, listen } from '$lib/services/bridge';
  import { toastStore } from '$lib/stores/toast.svelte';
  import type { GoalCommand, SessionGoal } from '$shared/session-goal';

  let { sessionId, ensureSession, chatId, space = 'home' }: {
    sessionId?: string;
    ensureSession: () => string;
    chatId: string;
    space?: 'home' | 'code';
  } = $props();

  const DEFAULT_CONSTRAINTS = 'Keep checks lightweight and avoid parallel heavy processes.';
  const PHASE_LABEL = { working: 'Active', evaluating: 'Checking', paused: 'Paused', needs_input: 'Needs input', achieved: 'Done' };

  let goal = $state<SessionGoal | null>(null);
  let open = $state(false);
  let busy = $state(false);
  let confirming = $state(false);
  let objective = $state('');
  let criteria = $state('');
  let constraints = $state('');
  let startNew = $state(false);

  const active = $derived(goal?.phase === 'working' || goal?.phase === 'evaluating');

  $effect(() => {
    const id = sessionId;
    goal = null;
    if (!id) return;

    let live = true;
    let off: (() => void) | undefined;
    const report = (error: unknown) => { if (live) toastStore.error(String(error)); };
    void invoke<SessionGoal | null>('agente_goal_get', { sessionId: id, chatId, space })
      .then(value => { if (live) goal = value; }).catch(report);
    void listen<SessionGoal & { cleared?: boolean }>('session_goal_changed', value => {
      if (live && value.sessionId === id) goal = value.cleared ? null : value;
    }).then(remove => { if (live) off = remove; else remove(); }).catch(report);
    return () => { live = false; off?.(); };
  });

  function edit() {
    startNew = !goal || goal.phase === 'achieved';
    objective = goal?.objective ?? '';
    criteria = goal?.criteria ?? '';
    constraints = goal?.constraints ?? DEFAULT_CONSTRAINTS;
    open = true;
  }

  async function save() {
    if (busy || !objective.trim()) return;
    busy = true;
    try {
      const id = sessionId || ensureSession();
      goal = await invoke<SessionGoal>('agente_goal_set', { sessionId: id, chatId, space, objective, criteria, constraints, start: startNew });
      open = false;
    } catch (error) {
      toastStore.error(String(error));
    } finally {
      busy = false;
    }
  }

  async function action(value: 'pause' | 'resume') {
    if (!sessionId || busy) return;
    busy = true;
    try {
      goal = await invoke<SessionGoal>('agente_goal_action', { sessionId, action: value });
    } catch (error) {
      toastStore.error(String(error));
    } finally {
      busy = false;
    }
  }

  async function clear() {
    if (!sessionId || busy) return;
    busy = true;
    try {
      await invoke('agente_goal_clear', { sessionId });
      goal = null;
      confirming = false;
      open = false;
    } catch (error) {
      toastStore.error(String(error));
    } finally {
      busy = false;
    }
  }

  function closeDialog() {
    if (confirming) confirming = false;
    else open = false;
  }

  export async function command(command: GoalCommand) {
    if (command.action === 'start') {
      startNew = true;
      objective = command.objective;
      criteria = '';
      constraints = DEFAULT_CONSTRAINTS;
      await save();
    } else if (command.action === 'edit' || command.action === 'view') {
      edit();
    } else if (command.action === 'clear') {
      if (goal) confirming = true;
    } else {
      await action(command.action);
    }
  }
</script>

{#if goal}
  <section class="goal-row" aria-label="Session goal" data-phase={goal.phase}>
    <Button variant="plain" class="goal-title" title={goal.objective} aria-haspopup="dialog" onclick={edit}>
      <Target class="size-3.5 shrink-0" />
      <span>{goal.objective}</span>
    </Button>
    <span class="goal-status" role="status" title={goal.phase === 'needs_input' ? goal.reason : undefined}>{PHASE_LABEL[goal.phase]}</span>
    {#if goal.phase !== 'achieved'}
      <IconButton label={active ? 'Pause goal' : 'Resume goal'} size="xs" quiet disabled={busy}
        onclick={() => action(active ? 'pause' : 'resume')}>
        {#if active}<Pause />{:else}<Play />{/if}
      </IconButton>
    {/if}
  </section>
{/if}

{#if open || confirming}
  <Dialog title={confirming ? 'Clear goal' : goal ? 'Edit goal' : 'Set a goal'} size="sm"
    onclose={closeDialog} beforeClose={() => !busy}>
    {#if confirming}
      <p class="goal-form">Clear this goal and stop automatic continuation? Your chat history will stay available.</p>
    {:else}
      <div class="goal-form">
        <Textarea data-autofocus aria-label="Goal" bind:value={objective} rows={3} maxlength={4000}
          placeholder="What should Agente accomplish?" />
        {#if goal?.phase === 'needs_input' && goal.reason}<p class="goal-note">{goal.reason}</p>{/if}
        <details>
          <summary>Details</summary>
          <div class="goal-fields">
            <label>Done when<Textarea bind:value={criteria} rows={2} maxlength={4000} /></label>
            <label>Constraints<Textarea bind:value={constraints} rows={2} maxlength={4000} /></label>
            {#if goal?.evidence.length}
              <div><p class="goal-note">Evidence</p><ul>{#each goal.evidence as evidence}<li>{evidence}</li>{/each}</ul></div>
            {/if}
          </div>
        </details>
      </div>
    {/if}
    {#snippet footer()}
      {#if confirming}
        <Button variant="ghost" disabled={busy} onclick={closeDialog}>Cancel</Button>
        <Button variant="destructive" loading={busy} onclick={clear}>Clear goal</Button>
      {:else}
        {#if goal}<Button variant="ghost" class="mr-auto" disabled={busy} onclick={() => (confirming = true)}>Clear goal</Button>{/if}
        <Button variant="ghost" disabled={busy} onclick={closeDialog}>Cancel</Button>
        <Button disabled={!objective.trim()} loading={busy} onclick={save}>{startNew ? 'Start goal' : 'Save'}</Button>
      {/if}
    {/snippet}
  </Dialog>
{/if}

<style>
  .goal-row {
    --goal-ink: var(--text-secondary);
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    margin-bottom: 0.25rem;
    padding-inline: 0.375rem;
    pointer-events: auto;
  }
  .goal-row:is([data-phase='working'], [data-phase='evaluating']) { --goal-ink: var(--brand-accent); }
  .goal-row[data-phase='needs_input'] { --goal-ink: var(--warning); }
  .goal-row :global(.goal-title) {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    min-height: 1.625rem;
    padding-inline: 0.375rem;
    font-size: var(--text-sm);
    text-align: left;
  }
  .goal-row :global(.goal-title:hover) { background: var(--float-row-hover); }
  .goal-row :global(.goal-title svg) { color: var(--goal-ink); }
  .goal-row :global(.goal-title span) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .goal-status { flex: none; color: var(--text-secondary); font-size: var(--text-xs); }
  .goal-form, .goal-fields { display: grid; gap: 0.625rem; }
  .goal-form { margin: 0; padding: 1rem; font-size: var(--text-sm); }
  .goal-form summary, .goal-note { color: var(--text-secondary); font-size: var(--text-xs); }
  .goal-form summary { cursor: pointer; }
  .goal-note { margin: 0; overflow-wrap: anywhere; }
  .goal-fields { padding-top: 0.625rem; }
  .goal-fields label { display: grid; gap: 0.25rem; }
  .goal-fields ul { margin: 0.25rem 0 0; padding-inline-start: 1.125rem; list-style: disc; overflow-wrap: anywhere; }
</style>

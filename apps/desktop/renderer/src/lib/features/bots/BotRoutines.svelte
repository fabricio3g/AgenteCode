<svelte:options runes={true} />

<!--
  What the open bot does on its own: each routine with when it runs next,
  a pause switch, and "run now". Answers land in the bot's chat.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { CalendarClock, Pencil, Play, Plus, Trash2, X } from 'lucide-svelte';
  import { Switch, Tooltip } from '$lib/components/ui';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { botsStore } from './bots.svelte';
  import type { Bot, Routine } from './bots-ipc';
  import { describeSchedule } from './routine-schedule';
  import RoutineEditor from './RoutineEditor.svelte';

  let { bot, onclose, embedded = false }: { bot: Bot; onclose: () => void; embedded?: boolean } = $props();

  let editing = $state<Routine | null>(null);
  let creating = $state(false);

  const routines = $derived(botsStore.routines[bot.handle] ?? []);

  function when(iso: string | null): string {
    if (!iso) return '';
    return new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function togglePaused(routine: Routine, running: boolean) {
    const { id, title, prompt, schedule } = routine;
    void botsStore.saveRoutine(bot.handle, { id, title, prompt, schedule, paused: !running });
  }

  function remove(routine: Routine) {
    confirmStore.show({
      title: $t('bots.deleteRoutineTitle'),
      message: $t('bots.deleteRoutineMessage', { values: { title: routine.title } }),
      confirmLabel: $t('bots.delete'),
      danger: true,
      onConfirm: () => void botsStore.deleteRoutine(bot.handle, routine.id)
    });
  }
</script>

<div class="flex h-full min-h-0 flex-col" role="region" aria-label={$t('bots.routines')}>
  <div class="flex h-10 shrink-0 items-center justify-between pl-3.5 pr-1.5">
    {#if !embedded}<p class="text-[13px] font-medium text-foreground">{$t('bots.routines')}</p>{:else}<span class="flex-1"></span>{/if}
    <div class="flex items-center">
      <Tooltip label={$t('bots.newRoutine')} position="bottom"><button type="button" class="ui-icon-button" onclick={() => (creating = true)} aria-label={$t('bots.newRoutine')}>
        <Plus class="size-3.5" />
      </button></Tooltip>
      {#if !embedded}<Tooltip label={$t('bots.close')} position="bottom"><button type="button" class="ui-icon-button" onclick={onclose} aria-label={$t('bots.close')}>
        <X class="size-3.5" />
      </button></Tooltip>{/if}
    </div>
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
    {#if !routines.length}
      <div class="empty">
        <CalendarClock class="size-5 text-muted-foreground" />
        <p class="text-[12.5px] text-muted-foreground">{$t('bots.noRoutines', { values: { name: bot.title } })}</p>
        <button type="button" class="link" onclick={() => (creating = true)}>{$t('bots.newRoutine')}</button>
      </div>
    {/if}
    {#each routines as routine (routine.id)}
      {@const schedule = describeSchedule(routine.schedule)}
      <div class="routine" class:paused={routine.paused}>
        <div class="flex items-start gap-2">
          <div class="min-w-0 flex-1">
            <p class="truncate text-[13px] font-medium text-foreground">{routine.title}</p>
            <p class="text-[13px] text-muted-foreground">{$t(schedule.key, { values: schedule.values })}</p>
          </div>
          <Switch checked={!routine.paused} label={$t('bots.routineOn')} onchange={(on: boolean) => togglePaused(routine, on)} />
        </div>
        <p class="meta">
          {#if routine.paused}
            {$t('bots.paused')}
          {:else if routine.next_run}
            {$t('bots.nextRun', { values: { when: when(routine.next_run) } })}
          {/if}
          {#if routine.last_run}
            · {$t(`bots.lastRun.${routine.last_run.status}`, { default: routine.last_run.status })}
          {/if}
        </p>
        <div class="actions">
          <button type="button" onclick={() => void botsStore.runRoutine(bot.handle, routine.id)} disabled={bot.working}>
            <Play class="size-3" /> {$t('bots.runNow')}
          </button>
          <button type="button" onclick={() => (editing = routine)}><Pencil class="size-3" /> {$t('bots.edit')}</button>
          <button type="button" onclick={() => remove(routine)} aria-label={$t('bots.delete')} title={$t('bots.delete')}><Trash2 class="size-3" /></button>
        </div>
      </div>
    {/each}
  </div>
</div>

{#if creating || editing}
  <RoutineEditor
    handle={bot.handle}
    routine={editing}
    onclose={() => {
      creating = false;
      editing = null;
    }}
  />
{/if}

<style>
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    padding: 2rem 0.5rem;
    text-align: center;
  }
  .link { font-size: 12.5px; color: var(--foreground); text-decoration: underline; text-underline-offset: 3px; }
  .routine {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    border-bottom: 1px solid var(--border-subtle);
    padding: 0.75rem 0.25rem;
  }
  .routine.paused { opacity: 0.6; }
  .meta { font-size: 11px; color: var(--muted-foreground); }
  .actions { display: flex; gap: 0.25rem; margin-left: -0.4rem; }
  .actions button {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    border-radius: 9999px;
    padding: 0.2rem 0.5rem;
    font-size: 11.5px;
    color: var(--muted-foreground);
  }
  .actions button:hover:not(:disabled) { background: var(--surface-hover); color: var(--foreground); }
  .actions button:disabled { opacity: 0.45; }
</style>

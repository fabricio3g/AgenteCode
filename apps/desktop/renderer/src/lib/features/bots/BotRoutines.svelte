<svelte:options runes={true} />

<!--
  What the open bot does on its own: each routine with when it runs next,
  a pause switch, and "run now". Answers land in the bot's chat.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { CalendarClock, Pencil, Play, Plus, Trash2, X } from 'lucide-svelte';
  import { Switch } from '$lib/components/ui';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { botsStore } from './bots.svelte';
  import type { Bot, Routine } from './bots-ipc';
  import { describeSchedule } from './routine-schedule';
  import RoutineEditor from './RoutineEditor.svelte';

  let { bot, onclose }: { bot: Bot; onclose: () => void } = $props();

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

<aside class="flex w-[17rem] shrink-0 flex-col border-l border-[var(--border-subtle)]" aria-label={$t('bots.routines')}>
  <div class="flex h-14 shrink-0 items-center justify-between px-4">
    <p class="text-[13px] font-medium text-foreground">{$t('bots.routines')}</p>
    <div class="flex items-center">
      <button type="button" class="icon-btn" onclick={() => (creating = true)} title={$t('bots.newRoutine')} aria-label={$t('bots.newRoutine')}>
        <Plus class="size-4" />
      </button>
      <button type="button" class="icon-btn" onclick={onclose} title={$t('bots.close')} aria-label={$t('bots.close')}>
        <X class="size-4" />
      </button>
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
            <p class="text-[11.5px] text-muted-foreground">{$t(schedule.key, { values: schedule.values })}</p>
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
</aside>

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
  .icon-btn {
    display: inline-flex;
    height: 1.9rem;
    width: 1.9rem;
    align-items: center;
    justify-content: center;
    border-radius: 9999px;
    color: var(--muted-foreground);
  }
  .icon-btn:hover { background: var(--surface-hover); color: var(--foreground); }
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

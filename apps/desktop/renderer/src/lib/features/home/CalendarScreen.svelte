<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { locale, t } from 'svelte-i18n';
  import { ArrowLeft, Check, ChevronLeft, ChevronRight, Link2, Pencil, Plus } from '$lib/icons';
  import Button from '$lib/components/ui/Button.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import PageHeader from '$lib/components/ui/PageHeader.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { listCalendarEvents, localCalendarDate, setTodoDone, type CalendarEvent } from '$lib/services/home-productivity';
  import { dayKey, firstDayOfWeek, monthWeeks, today, weekdayLabels } from './calendar-model';
  import { useCalendar } from './calendar-state.svelte';
  import CalendarEventDialog from './CalendarEventDialog.svelte';
  import CalendarSourcesDialog from './CalendarSourcesDialog.svelte';
  import { calendarSync } from './calendar-sync.svelte';
  import { isElectron } from '$lib/services/bridge';

  const calendar = useCalendar();
  let selected = $state(untrack(() => appStore.calendarDay == null ? today() : new Date(appStore.calendarDay)));
  let grid = $state<HTMLTableElement>();
  let editor = $state<CalendarEvent | 'new' | null>(null);
  let sources = $state<'manage' | 'add' | null>(null);
  const lang = $derived($locale || 'en');
  const weekStart = $derived(firstDayOfWeek(lang));
  const monthLabel = $derived(new Intl.DateTimeFormat(lang, { month: 'long', year: 'numeric' }).format(selected));
  const fullDate = $derived(new Intl.DateTimeFormat(lang, { dateStyle: 'full' }));
  const timeFormat = $derived(new Intl.DateTimeFormat(lang, { timeStyle: 'short' }));
  const weekdays = $derived(weekdayLabels(lang, weekStart));
  const weeks = $derived(monthWeeks(selected, weekStart));
  const selectedKey = $derived(dayKey(selected));
  const todayKey = $derived(dayKey(calendar.current));
  const selectedEntries = $derived(calendar.entriesOn(selected));

  function moveMonth(delta: number) {
    const target = new Date(selected);
    target.setMonth(selected.getMonth() + delta, 1);
    const end = new Date(target);
    end.setMonth(target.getMonth() + 1, 0);
    target.setDate(Math.min(selected.getDate(), end.getDate()));
    selected = target;
  }
  async function navigate(event: KeyboardEvent, date: Date) {
    let next = new Date(date);
    if (event.key === 'ArrowLeft') next.setDate(next.getDate() - 1);
    else if (event.key === 'ArrowRight') next.setDate(next.getDate() + 1);
    else if (event.key === 'ArrowUp') next.setDate(next.getDate() - 7);
    else if (event.key === 'ArrowDown') next.setDate(next.getDate() + 7);
    else if (event.key === 'Home') next.setDate(next.getDate() - (next.getDay() - weekStart + 7) % 7);
    else if (event.key === 'End') next.setDate(next.getDate() + 6 - (next.getDay() - weekStart + 7) % 7);
    else if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault();
      selected = date;
      moveMonth((event.key === 'PageUp' ? -1 : 1) * (event.shiftKey ? 12 : 1));
      await tick();
      grid?.querySelector<HTMLButtonElement>('[tabindex="0"]')?.focus();
      return;
    } else return;
    event.preventDefault();
    selected = next;
    await tick();
    grid?.querySelector<HTMLButtonElement>('[tabindex="0"]')?.focus();
  }

  function eventSaved(day: string) {
    selected = localCalendarDate(day) ?? selected;
    editor = null;
  }
</script>

<section class="calendar" aria-label={$t('home.calendar.title')}>
  <div class="calendar-content">
    <PageHeader title={$t('home.calendar.title')}>
      {#snippet actions()}
        <Button variant="ghost" size="sm" onclick={() => { appStore.homeView = 'chat'; }}><ArrowLeft /> {$t('artifacts.backToChat')}</Button>
        {#if isElectron()}<Button variant="secondary" size="sm" onclick={() => { sources = 'add'; }}><Link2 /> {$t('home.calendarSync.add')}</Button>{/if}
        <Button size="sm" onclick={() => { editor = 'new'; }}><Plus /> {$t('home.calendar.add')}</Button>
      {/snippet}
    </PageHeader>
    <div class="calendar-body">
      <div class="month-view">
      <div class="month">
        <h2 aria-live="polite">{monthLabel}</h2>
        <div class="flex items-center gap-0.5">
          <Button variant="ghost" size="sm" onclick={() => { selected = calendar.current; }}>{$t('home.calendar.today')}</Button>
          <IconButton label={$t('home.calendar.previous')} size="sm" onclick={() => moveMonth(-1)}><ChevronLeft /></IconButton>
          <IconButton label={$t('home.calendar.next')} size="sm" onclick={() => moveMonth(1)}><ChevronRight /></IconButton>
        </div>
      </div>
      <table bind:this={grid} role="grid" aria-label={monthLabel}>
        <thead><tr>{#each weekdays as weekday, index (index)}<th scope="col">{weekday}</th>{/each}</tr></thead>
        <tbody>
          {#each weeks as week, index (index)}
            <tr>{#each week as date (dayKey(date))}
              {@const key = dayKey(date)}
              {@const items = calendar.entriesOn(date)}
              <td role="gridcell" aria-selected={key === selectedKey}>
                <Button variant="plain" type="button" class={`calendar-day${date.getMonth() !== selected.getMonth() ? ' outside' : ''}${key === todayKey ? ' current' : ''}${key === selectedKey ? ' selected' : ''}`}
                  aria-label={items.length ? `${fullDate.format(date)}, ${$t('home.calendar.entryCount', { values: { count: items.length } })}` : fullDate.format(date)}
                  aria-current={key === todayKey ? 'date' : undefined}
                  tabindex={key === selectedKey ? 0 : -1}
                  onclick={() => { selected = date; }} onkeydown={event => void navigate(event, date)}>
                  <span class="day-number">{date.getDate()}</span>
                  {#if items.length}
                    <span class="day-entries" aria-hidden="true">
                      {#each items.slice(0, 2) as item (item.id)}
                        <span class="day-entry calendar-tone" data-tone={item.color}>
                          <span class="calendar-dot"></span>
                          <span class="day-entry-text">{item.text || $t('home.calendarSync.untitled')}</span>
                        </span>
                      {/each}
                      {#if items.length > 2}<span class="day-more">+{items.length - 2}</span>{/if}
                    </span>
                  {/if}
                </Button>
              </td>
            {/each}</tr>
          {/each}
        </tbody>
      </table>
      </div>
      <section class="agenda" aria-live="polite" aria-labelledby="calendar-agenda-title">
        <h2 class="agenda-title" id="calendar-agenda-title">{fullDate.format(selected)}</h2>
        {#if selectedEntries.length}
          <ul>{#each selectedEntries as entry (entry.id)}
            <li class="calendar-tone" data-tone={entry.color}>
              <span class="calendar-dot" aria-hidden="true"></span>
              <span class="entry-text">{entry.text || $t('home.calendarSync.untitled')}
                <span class="entry-time">{entry.kind === 'calendar' ? entry.source : $t(`home.calendar.kinds.${entry.kind}`)}{#if entry.timed} · {timeFormat.format(entry.date)}{:else if !entry.continuation && (entry.kind === 'event' || entry.kind === 'calendar')} · {$t('home.calendar.allDay')}{/if}</span>
              </span>
              {#if entry.kind === 'todo'}<IconButton label={$t('home.calendar.complete', { values: { task: entry.text } })} size="xs" onclick={() => setTodoDone(entry.id)}><Check /></IconButton>{/if}
              {#if entry.kind === 'event'}<IconButton label={$t('home.calendar.editEntry', { values: { title: entry.text } })} size="xs" onclick={() => { editor = listCalendarEvents().find(event => event.id === entry.id) ?? null; }}><Pencil /></IconButton>{/if}
            </li>
          {/each}</ul>
        {:else}<p>{$t('home.calendar.empty')}</p>{/if}
        {#if calendarSync.calendars.length}
          <Button variant="ghost" size="sm" class="mt-3" onclick={() => { sources = 'manage'; }}><Link2 /> {$t('home.calendarSync.manage')}</Button>
        {/if}
      </section>
    </div>
  </div>
</section>

{#if editor}
  <CalendarEventDialog day={selectedKey} event={editor === 'new' ? undefined : editor} onsave={eventSaved} onclose={() => { editor = null; }} />
{/if}
{#if sources}
  <CalendarSourcesDialog manage={sources === 'manage'} onclose={() => { sources = null; }} />
{/if}

<style>
  .calendar { min-width:0; min-height:0; flex:1; overflow-y:auto; }
  .calendar-content { max-width:1100px; margin:0 auto; padding:2rem clamp(1.25rem, 4vw, 2rem) 3rem; }
  .calendar-body { display:grid; grid-template-columns:minmax(0, 3fr) minmax(13rem, 1fr); gap:1.5rem; margin-top:1.5rem; }
  .month-view { min-width:0; container-type:inline-size; }
  .month { display:flex; align-items:center; justify-content:space-between; gap:0.5rem; padding:0 0.25rem 0.75rem; color:var(--foreground); font-size:var(--text-base); font-weight:600; }
  .month h2 { font:inherit; }
  .month h2::first-letter { text-transform:uppercase; }
  table { width:100%; table-layout:fixed; border-collapse:collapse; }
  th { padding:0.5rem 0; color:var(--text-secondary); font-size:var(--text-xs); font-weight:400; overflow:hidden; }
  td { padding:2px; vertical-align:top; border-top:1px solid var(--border-subtle); }
  :global(.calendar-day) { display:flex; flex-direction:column; gap:0.125rem; width:100%; min-height:5.75rem; padding:0.25rem; border-radius:var(--radius-sm); color:var(--foreground); text-align:left; }
  :global(.calendar-day:hover) { background:var(--surface-hover); }
  :global(.calendar-day:focus-visible) { outline:2px solid var(--ring); outline-offset:-2px; }
  :global(.calendar-day.outside) { color:var(--muted-foreground); }
  :global(.calendar-day.selected) { background:var(--surface-hover); }
  .day-number { display:grid; place-items:center; min-width:1.5rem; min-height:1.5rem; align-self:flex-start; font-size:var(--text-sm); border-radius:50%; }
  :global(.calendar-day.current) .day-number { box-shadow:inset 0 0 0 1px var(--ring); font-weight:600; }
  :global(.calendar-day.selected) .day-number { background:var(--foreground); color:var(--background); }
  .day-entries { display:grid; gap:0.125rem; width:100%; min-width:0; }
  .day-entry { display:flex; align-items:center; gap:0.25rem; min-width:0; padding:0.125rem 0.25rem; border-radius:var(--radius-sm); background:color-mix(in srgb, var(--calendar-tone) 13%, var(--background)); }
  .day-entry-text { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:var(--text-xs); }
  .day-more { color:var(--text-secondary); font-size:var(--text-xs); }
  .agenda { min-width:0; padding-top:0.25rem; font-size:var(--text-sm); }
  .agenda-title { min-height:2.5rem; padding-bottom:0.75rem; border-bottom:1px solid var(--border-subtle); color:var(--foreground); font-size:var(--text-base); font-weight:500; }
  .agenda p { margin:0.75rem 0 0; color:var(--text-secondary); }
  .agenda ul { margin:0; padding:0; list-style:none; }
  .agenda li { display:flex; align-items:center; gap:0.5rem; padding:0.75rem 0; border-bottom:1px solid var(--border-subtle); }
  .entry-text { flex:1; min-width:0; overflow-wrap:anywhere; color:var(--foreground); }
  .entry-time { display:block; color:var(--text-secondary); }
  @container (max-width:33rem) {
    :global(.calendar-day) { align-items:center; min-height:3.5rem; }
    .day-number { align-self:center; }
    .day-entries { display:flex; justify-content:center; align-items:center; }
    .day-entry { padding:0; background:none; }
    .day-entry-text, .day-more { display:none; }
  }
  @media (max-width:820px) { .calendar-body { grid-template-columns:minmax(0,1fr); gap:1.5rem; } }
</style>

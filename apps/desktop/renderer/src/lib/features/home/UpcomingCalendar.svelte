<script lang="ts">
  import { locale, t } from 'svelte-i18n';
  import { CalendarDays, ChevronRight } from '$lib/icons';
  import Button from '$lib/components/ui/Button.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { useCalendar } from './calendar-state.svelte';
  import { dayKey } from './calendar-model';

  const calendar = useCalendar();
  const entries = $derived.by(() => {
    const result = new Map<string, ReturnType<typeof calendar.entriesOn>[number]>();
    const day = new Date(calendar.current);
    for (let offset = 0; offset < 7 && result.size < 3; offset++) {
      for (const entry of calendar.entriesOn(day)) {
        if (!result.has(entry.id)) result.set(entry.id, entry);
        if (result.size === 3) break;
      }
      day.setDate(day.getDate() + 1);
    }
    return [...result.values()];
  });
  const dateFormat = $derived(new Intl.DateTimeFormat($locale || 'en', { weekday: 'short', month: 'short', day: 'numeric' }));
  const timeFormat = $derived(new Intl.DateTimeFormat($locale || 'en', { timeStyle: 'short' }));
</script>

{#if entries.length}
  <section class="upcoming composer-column px-3 md:px-6" aria-label={$t('home.calendar.upcoming')}>
    <div class="upcoming-heading">
      <h2><CalendarDays class="size-4 shrink-0" aria-hidden="true" /> {$t('home.calendar.upcoming')}</h2>
      <Button variant="ghost" size="sm" onclick={() => appStore.showCalendar()}>{$t('home.calendar.title')} <ChevronRight /></Button>
    </div>
    <ul>
      {#each entries as entry (entry.id)}
        <li>
          <Button variant="plain" class="upcoming-entry calendar-tone" data-tone={entry.color} onclick={() => appStore.showCalendar(entry.date)}>
            <span class="calendar-dot" aria-hidden="true"></span>
            <span class="entry-title" title={entry.text || $t('home.calendarSync.untitled')}>{entry.text || $t('home.calendarSync.untitled')}</span>
            <span class="entry-date">
              {dayKey(entry.date) === dayKey(calendar.current) ? $t('home.calendar.today') : dateFormat.format(entry.date)}
              {#if entry.timed} · {timeFormat.format(entry.date)}{/if}
            </span>
          </Button>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .upcoming { flex-shrink:0; margin-bottom:0.75rem; font-size:var(--text-sm); }
  .upcoming-heading { display:flex; align-items:center; justify-content:space-between; gap:0.5rem; }
  h2 { display:flex; align-items:center; gap:0.5rem; color:var(--text-secondary); font-weight:500; }
  ul { margin:0; padding:0; list-style:none; }
  :global(.upcoming-entry) { display:flex; align-items:center; gap:0.5rem; width:100%; min-width:0; padding:0.375rem 0.5rem; text-align:left; }
  :global(.upcoming-entry:hover) { background:var(--surface-hover); }
  .entry-title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .entry-date { color:var(--text-secondary); text-align:right; }
</style>

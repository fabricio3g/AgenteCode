import { onMount } from 'svelte';
import { HOME_PRODUCTIVITY_CHANGED } from '$lib/services/home-productivity';
import { calendarEntries, dayKey, syncedCalendarEntries, today, type CalendarEntry } from './calendar-model';
import { calendarSync, watchCalendarSync } from './calendar-sync.svelte';

export function useCalendar() {
  watchCalendarSync();
  let localEntries = $state(calendarEntries());
  const entries = $derived([...localEntries, ...syncedCalendarEntries(calendarSync.calendars)].sort((a, b) => +a.date - +b.date));
  const spanning = $derived(entries.filter(entry => entry.end && dayKey(entry.end) !== dayKey(entry.date)));
  let current = $state(today());
  const days = $derived.by(() => {
    const result = new Map<string, CalendarEntry[]>();
    for (const entry of entries) {
      const key = dayKey(entry.date);
      const day = result.get(key);
      if (day) day.push(entry);
      else result.set(key, [entry]);
    }
    return result;
  });

  onMount(() => {
    let midnight: ReturnType<typeof setTimeout>;
    const refresh = () => {
      current = today();
      localEntries = calendarEntries();
      clearTimeout(midnight);
      const next = new Date(current);
      next.setDate(next.getDate() + 1);
      midnight = setTimeout(refresh, Math.max(1, next.getTime() - Date.now()));
    };
    refresh();
    window.addEventListener(HOME_PRODUCTIVITY_CHANGED, refresh);
    window.addEventListener('storage', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      clearTimeout(midnight);
      window.removeEventListener(HOME_PRODUCTIVITY_CHANGED, refresh);
      window.removeEventListener('storage', refresh);
      window.removeEventListener('focus', refresh);
    };
  });

  return {
    get current() { return current; },
    entriesOn(day: Date): CalendarEntry[] {
      const start = new Date(day);
      start.setHours(0, 0, 0, 0);
      const continuing = spanning.filter(entry => entry.date < start && entry.end! > start)
        .map(entry => ({ ...entry, date: start, timed: false, continuation: true }));
      return [...continuing, ...(days.get(dayKey(day)) ?? [])];
    },
  };
}

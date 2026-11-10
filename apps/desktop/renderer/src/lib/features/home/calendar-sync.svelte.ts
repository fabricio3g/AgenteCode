import { onMount } from 'svelte';
import { invoke, isElectron, listen } from '$lib/services/bridge';
import type { CalendarSyncSnapshot } from '$shared/calendar-sync';

let snapshot = $state<CalendarSyncSnapshot>({ calendars: [], providers: { google: false, outlook: false } });
let unavailable = $state(false);
let listeners = 0;
let revision = 0;
let stop: (() => void) | undefined;
let subscription = 0;

function update(next: CalendarSyncSnapshot) {
  if (!next || !Array.isArray(next.calendars)) return;
  snapshot = next;
  unavailable = false;
}

async function load() {
  const requested = ++revision;
  try {
    const next = await invoke<CalendarSyncSnapshot>('calendar_sync_list');
    if (requested === revision) update(next);
  } catch {
    if (requested === revision) unavailable = true;
  }
}

export async function calendarChange(channel: string, args: Record<string, unknown>) {
  const next = await invoke<CalendarSyncSnapshot>(channel, args);
  revision++;
  update(next);
  // A sync may have finished after the mutation reply was queued.
  void load();
}

export function watchCalendarSync() {
  onMount(() => {
    if (!isElectron()) return;
    listeners++;
    if (listeners === 1) {
      const key = ++subscription;
      void listen('calendar_sync_changed', () => void load()).then(off => {
        if (key === subscription) stop = off;
        else off();
      }).catch(() => {});
      void load();
      window.addEventListener('focus', load);
    }
    return () => {
      if (--listeners === 0) {
        subscription++;
        stop?.();
        stop = undefined;
        window.removeEventListener('focus', load);
      }
    };
  });
}

export const calendarSync = {
  get calendars() { return snapshot.calendars; },
  get providers() { return snapshot.providers; },
  get unavailable() { return unavailable; },
};

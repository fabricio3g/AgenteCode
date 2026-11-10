export type CalendarProvider = 'google' | 'outlook' | 'link';
export type CalendarAccountProvider = Exclude<CalendarProvider, 'link'>;

export interface SyncedCalendarEvent {
  id: string;
  title: string;
  /** Date-only for all-day entries, ISO timestamp for timed entries. */
  start: string;
  /** Exclusive end, in the same format as start. */
  end?: string;
}

export interface SyncedCalendar {
  id: string;
  name: string;
  provider: CalendarProvider;
  lastSynced?: number;
  error?: 'offline' | 'signIn' | 'limited' | 'unavailable';
  events: SyncedCalendarEvent[];
}

export interface CalendarSyncSnapshot {
  calendars: SyncedCalendar[];
  providers: Record<CalendarAccountProvider, boolean>;
}

export interface CalendarAccountSelection {
  session: string;
  calendars: { id: string; name: string; primary?: boolean }[];
}

import { EVENT_COLORS, listCalendarEvents, listReminders, listTodos, localCalendarDate, type EventColor } from '$lib/services/home-productivity';
import type { SyncedCalendar } from '$shared/calendar-sync';

export const today = () => { const date = new Date(); date.setHours(0, 0, 0, 0); return date; };
export const dayKey = (date: Date) => `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

function dueDate(value: string): Date {
  return localCalendarDate(value) ?? new Date(value);
}

export function firstDayOfWeek(lang: string): number {
  try {
    const info = new Intl.Locale(lang) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    return (info.getWeekInfo?.().firstDay ?? info.weekInfo?.firstDay ?? 1) % 7;
  } catch { return 1; }
}

export function weekdayLabels(lang: string, weekStart: number): string[] {
  const formatter = new Intl.DateTimeFormat(lang, { weekday: 'short' });
  return Array.from({ length: 7 }, (_, index) => formatter.format(new Date(2024, 0, 7 + (weekStart + index) % 7)));
}

export function monthWeeks(date: Date, weekStart: number): Date[][] {
  const first = new Date(date);
  first.setDate(1);
  first.setHours(0, 0, 0, 0);
  const last = new Date(first);
  last.setMonth(first.getMonth() + 1, 0);
  const offset = (first.getDay() - weekStart + 7) % 7;
  const count = Math.ceil((offset + last.getDate()) / 7);
  return Array.from({ length: count }, (_, week) => Array.from({ length: 7 }, (_, day) => {
    const cell = new Date(first);
    cell.setDate(1 - offset + week * 7 + day);
    return cell;
  }));
}

export type CalendarEntry = {
  id: string;
  text: string;
  date: Date;
  kind: 'event' | 'todo' | 'reminder' | 'calendar';
  color: EventColor;
  timed: boolean;
  source?: string;
  end?: Date;
  continuation?: boolean;
};

export function syncedCalendarEntries(calendars: SyncedCalendar[]): CalendarEntry[] {
  const colors: EventColor[] = ['blue', 'violet', 'green', 'amber'];
  return calendars.flatMap((calendar, index) => calendar.events.flatMap((event): CalendarEntry[] => {
    const allDay = /^\d{4}-\d{2}-\d{2}$/.test(event.start);
    const date = allDay ? localCalendarDate(event.start) : new Date(event.start);
    if (!date || !Number.isFinite(date.getTime())) return [];
    const end = event.end ? (allDay ? localCalendarDate(event.end) : new Date(event.end)) : undefined;
    return [{
      id: `${calendar.id}:${event.id}`, text: event.title, date, kind: 'calendar',
      color: colors[index % colors.length], timed: !allDay, source: calendar.name,
      end: end && +end > +date ? end : undefined,
    }];
  }));
}

export function calendarEntries(): CalendarEntry[] {
  const todos = listTodos().flatMap((todo): CalendarEntry[] => {
    if (!todo.due) return [];
    const date = dueDate(todo.due);
    return Number.isNaN(date.getTime()) ? [] : [{ id: todo.id, text: todo.text, date, kind: 'todo', color: 'green', timed: todo.due.includes('T') }];
  });
  const reminders = listReminders().flatMap((reminder): CalendarEntry[] => {
    const date = new Date(reminder.fireAt);
    return Number.isNaN(date.getTime()) ? [] : [{ id: reminder.id, text: reminder.text, date, kind: 'reminder', color: 'amber', timed: true }];
  });
  const events = listCalendarEvents().flatMap((event): CalendarEntry[] => {
    const date = localCalendarDate(event.day, event.time);
    return date ? [{ id: event.id, text: event.text, date, kind: 'event', color: EVENT_COLORS.includes(event.color) ? event.color : 'blue', timed: !!event.time }] : [];
  });
  return [...todos, ...reminders, ...events].sort((a, b) => a.date.getTime() - b.date.getTime());
}

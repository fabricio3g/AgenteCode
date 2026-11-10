import ICAL from 'ical.js';
import type { SyncedCalendarEvent } from '../../shared/calendar-sync.ts';

export const MAX_EVENTS = 10_000;

export function syncWindow(now = new Date()) {
  const from = new Date(now);
  const to = new Date(now);
  from.setDate(from.getDate() - 90);
  to.setDate(to.getDate() + 366);
  return { from, to };
}

function dateValue(time: ICAL.Time): string {
  return time.isDate ? time.toString() : time.toJSDate().toISOString();
}

/** Expand occurrences within the displayed window, including moved and cancelled instances. */
export function parseCalendarFeed(source: string, from: Date, to: Date) {
  const calendar = new ICAL.Component(ICAL.parse(source.replace(/^\uFEFF/, '')));
  if (calendar.name !== 'vcalendar') throw new Error('This link did not return an iCalendar feed.');
  const components = calendar.getAllSubcomponents('vevent');
  if (components.length > MAX_EVENTS) throw new Error('This calendar has too many events to sync.');

  const exceptions = new Map<string, ICAL.Event[]>();
  const series: ICAL.Event[] = [];
  for (const component of components) {
    const event = new ICAL.Event(component, { exceptions: [] });
    if (event.isRecurrenceException()) {
      // Providers may send a cancelled recurrence with only a RECURRENCE-ID.
      // ICAL's exception lookup still expects a start from which to derive its end.
      if (!event.startDate) {
        if (component.getFirstPropertyValue('status') !== 'CANCELLED') continue;
        event.startDate = event.recurrenceId;
      }
      const list = exceptions.get(event.uid) ?? [];
      list.push(event);
      exceptions.set(event.uid, list);
    } else if (component.getFirstPropertyValue('status') !== 'CANCELLED') {
      series.push(event);
    }
  }

  const events: SyncedCalendarEvent[] = [];
  const append = (event: ICAL.Event, instance: ICAL.Time, start: ICAL.Time, end: ICAL.Time) => {
    if (event.component.getFirstPropertyValue('status') === 'CANCELLED' || start.toJSDate() >= to || (end.toJSDate() <= from && start.toJSDate() < from)) return;
    if (events.length >= MAX_EVENTS) throw new Error('This calendar has too many events to sync.');
    events.push({ id: `${event.uid}:${instance.toString()}`, title: String(event.summary || '').slice(0, 500), start: dateValue(start), end: dateValue(end) });
  };
  let scanned = 0;
  for (const event of series) {
    if (!event.startDate) continue;
    const overrides = exceptions.get(event.uid) ?? [];
    for (const override of overrides) event.relateException(override);
    if (!event.isRecurring()) {
      append(event, event.startDate, event.startDate, event.endDate);
      continue;
    }
    const visited = new Set<string>();
    const iterator = event.iterator();
    for (let occurrence = iterator.next(); occurrence && occurrence.toJSDate() < to; occurrence = iterator.next()) {
      if (++scanned > 150_000) throw new Error('This calendar has too many recurring events to sync.');
      const detail = event.getOccurrenceDetails(occurrence);
      visited.add(occurrence.toString());
      visited.add(occurrence.convertToZone(ICAL.Timezone.utcTimezone).toString());
      append(detail.item, occurrence, detail.startDate, detail.endDate);
    }
    // A future occurrence can be rescheduled into the displayed window.
    for (const override of overrides) {
      if (override.startDate && !visited.has(override.recurrenceId.toString())) {
        append(override, override.recurrenceId, override.startDate, override.endDate);
      }
    }
  }
  return { name: String(calendar.getFirstPropertyValue('x-wr-calname') || '').trim().slice(0, 80), events };
}

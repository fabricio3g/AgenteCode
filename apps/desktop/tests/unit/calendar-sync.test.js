import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calendarFeedUrl, fetchCalendarFeed } from '../../main/calendar/feed.ts';
import { parseCalendarFeed } from '../../main/calendar/ical.ts';

const from = new Date('2026-11-01T00:00:00Z');
const to = new Date('2026-12-01T00:00:00Z');
const fixture = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:Work', ...events.flatMap(event => ['BEGIN:VEVENT', ...event, 'END:VEVENT']), 'END:VCALENDAR'].join('\r\n');

test('expands recurrence exceptions and preserves all-day dates', () => {
  const source = fixture(
    ['UID:daily', 'DTSTART:20261105T150000Z', 'DTEND:20261105T153000Z', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:Check-in'],
    ['UID:daily', 'RECURRENCE-ID:20261106T150000Z', 'DTSTART:20261106T180000Z', 'DTEND:20261106T183000Z', 'SUMMARY:Moved'],
    ['UID:daily', 'RECURRENCE-ID:20261107T150000Z', 'STATUS:CANCELLED'],
    ['UID:allday', 'DTSTART;VALUE=DATE:20261110', 'DTEND;VALUE=DATE:20261112', 'SUMMARY:Offsite'],
  );
  const result = parseCalendarFeed(source, from, to);
  assert.equal(result.name, 'Work');
  assert.deepEqual(result.events.map(({ title, start, end }) => [title, start, end]), [
    ['Check-in', '2026-11-05T15:00:00.000Z', '2026-11-05T15:30:00.000Z'],
    ['Moved', '2026-11-06T18:00:00.000Z', '2026-11-06T18:30:00.000Z'],
    ['Offsite', '2026-11-10', '2026-11-12'],
  ]);
});

test('normalizes webcal and rejects local or credential-bearing targets', async () => {
  assert.equal(calendarFeedUrl('webcal://calendar.example.com/work.ics').protocol, 'https:');
  assert.throws(() => calendarFeedUrl('https://user:password@calendar.example.com/work.ics'));
  await assert.rejects(fetchCalendarFeed('https://127.0.0.1/private.ics'), /public server/);
  await assert.rejects(fetchCalendarFeed('https://[::1]/private.ics'), /public server/);
});

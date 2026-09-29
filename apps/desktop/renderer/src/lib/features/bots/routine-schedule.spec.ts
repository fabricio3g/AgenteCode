import { describe, expect, it } from 'vitest';
import { describeSchedule, formFrom, toSchedule } from './routine-schedule';

describe('routine schedules', () => {
  it('round-trips every frequency through the form', () => {
    for (const schedule of [
      { every: 'hour', minute: 15 },
      { every: 'day', at: '08:00' },
      { every: 'weekdays', at: '09:30' },
      { every: 'week', day: 'fri', at: '17:00' },
      { every: 'cron', expr: '0 12 1 * *' }
    ] as const) {
      expect(toSchedule(formFrom(schedule))).toEqual(schedule);
    }
  });

  it('keeps an hourly minute in range and reads a spelled-out day', () => {
    expect(toSchedule({ ...formFrom(undefined), every: 'hour', minute: 75 })).toEqual({ every: 'hour', minute: 59 });
    expect(formFrom({ every: 'week', day: 'Sunday', at: '18:00' }).day).toBe('sun');
  });

  it('describes a schedule for the list', () => {
    expect(describeSchedule({ every: 'hour', minute: 5 })).toEqual({ key: 'bots.schedule.hourly', values: { minute: '05' } });
    expect(describeSchedule({ every: 'week', day: 'tue', at: '10:00' }).key).toBe('bots.schedule.weekly.tue');
  });
});

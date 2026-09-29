// Routine schedules for the UI: a readable line for each, and the form
// state the editor edits. Pure, so it is directly testable.

import type { Schedule } from './bots-ipc';

export type Frequency = Schedule['every'];

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/** Everything the editor may show at once; `toSchedule` picks what applies. */
export interface ScheduleForm {
  every: Frequency;
  at: string;
  minute: number;
  day: (typeof WEEKDAYS)[number];
  expr: string;
}

export function formFrom(schedule: Schedule | undefined): ScheduleForm {
  const form: ScheduleForm = { every: 'day', at: '08:00', minute: 0, day: 'mon', expr: '0 9 * * 1-5' };
  if (!schedule) return form;
  form.every = schedule.every;
  if ('at' in schedule) form.at = schedule.at;
  if (schedule.every === 'hour') form.minute = schedule.minute;
  if (schedule.every === 'week') form.day = (WEEKDAYS.find((day) => schedule.day.toLowerCase().startsWith(day)) ?? 'mon');
  if (schedule.every === 'cron') form.expr = schedule.expr;
  return form;
}

export function toSchedule(form: ScheduleForm): Schedule {
  switch (form.every) {
    case 'hour':
      return { every: 'hour', minute: Math.min(59, Math.max(0, Math.round(form.minute) || 0)) };
    case 'weekdays':
      return { every: 'weekdays', at: form.at };
    case 'week':
      return { every: 'week', day: form.day, at: form.at };
    case 'cron':
      return { every: 'cron', expr: form.expr.trim() };
    default:
      return { every: 'day', at: form.at };
  }
}

/** Translation key and values for a one-line description of `schedule`. */
export function describeSchedule(schedule: Schedule): { key: string; values: Record<string, string | number> } {
  switch (schedule.every) {
    case 'hour':
      return { key: 'bots.schedule.hourly', values: { minute: String(schedule.minute).padStart(2, '0') } };
    case 'day':
      return { key: 'bots.schedule.daily', values: { at: schedule.at } };
    case 'weekdays':
      return { key: 'bots.schedule.weekdays', values: { at: schedule.at } };
    case 'week':
      return { key: `bots.schedule.weekly.${formFrom(schedule).day}`, values: { at: schedule.at } };
    case 'cron':
      return { key: 'bots.schedule.cron', values: { expr: schedule.expr } };
  }
}

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import type { CalendarSyncSnapshot } from '$shared/calendar-sync';
import { afterEach, expect, it, vi } from 'vitest';
import { addTodo, cancelReminder, listCalendarEvents, listReminders, listTodos, saveCalendarEvent, setReminder } from '$lib/services/home-productivity';
import CalendarScreen from './CalendarScreen.svelte';
import UpcomingCalendar from './UpcomingCalendar.svelte';

const appStore = vi.hoisted(() => ({ homeView: 'calendar', showCalendar: vi.fn() }));
vi.mock('$lib/stores/app.svelte', () => ({ appStore }));

afterEach(() => { cleanup(); listReminders().forEach(reminder => cancelReminder(reminder.id)); localStorage.clear(); vi.useRealTimers(); vi.clearAllMocks(); });

it('shows dated tasks on the selected local day and updates after completion', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 5, 12));
  addTodo({ text: 'Review the draft', due: '2026-11-06' });
  const reminder = setReminder({ text: 'Call the team', inMinutes: 24 * 60 });
  render(CalendarScreen);
  const grid = screen.getByRole('grid');
  const today = within(grid).getByRole('button', { name: /Thursday, November 5, 2026/ });
  await fireEvent.keyDown(today, { key: 'ArrowRight' });
  const agenda = within(screen.getByRole('region', { name: 'Friday, November 6, 2026' }));
  expect(agenda.getByText('Review the draft')).toBeTruthy();
  expect(agenda.getByText('Call the team')).toBeTruthy();
  expect(document.activeElement?.getAttribute('aria-label')).toMatch(/Friday, November 6, 2026/);
  await fireEvent.click(screen.getByRole('button', { name: 'Complete Review the draft' }));
  expect(screen.queryByText('Review the draft')).toBeNull();
  expect(listTodos({ status: 'done' })).toHaveLength(1);
  cancelReminder(reminder.id);
  await tick();
  expect(screen.getByText('Nothing scheduled')).toBeTruthy();
  await fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
  expect(screen.getByRole('grid', { name: 'December 2026' })).toBeTruthy();
  await fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }));
  expect(appStore.homeView).toBe('chat');
});

it('creates, reopens, edits, and removes a colored calendar event', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 5, 12));
  render(CalendarScreen);
  await fireEvent.click(screen.getByRole('button', { name: 'Add event' }));
  const dialog = within(await screen.findByRole('dialog'));
  await fireEvent.input(dialog.getByLabelText('Event title'), { target: { value: 'Design review' } });
  await fireEvent.input(dialog.getByLabelText('Time (optional)'), { target: { value: '13:30' } });
  await fireEvent.click(dialog.getByRole('radio', { name: 'Violet' }));
  await fireEvent.submit(document.getElementById('calendar-event-form')!);
  expect(listCalendarEvents()[0]).toMatchObject({ text: 'Design review', day: '2026-11-05', time: '13:30', color: 'violet' });
  cleanup();
  render(CalendarScreen);
  const edit = await screen.findByRole('button', { name: 'Edit Design review' });
  await fireEvent.click(edit);
  await fireEvent.input(screen.getByLabelText('Event title'), { target: { value: 'Design check-in' } });
  await fireEvent.submit(document.getElementById('calendar-event-form')!);
  expect(listCalendarEvents().map(event => event.text)).toEqual(['Design check-in']);
  await fireEvent.click(await screen.findByRole('button', { name: 'Edit Design check-in' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Remove event' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Remove event' }));
  expect(listCalendarEvents()).toEqual([]);
});

it('shows nearby calendar items on Home and opens their dates', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 5, 12));
  saveCalendarEvent({ text: 'This week', day: '2026-11-06', color: 'blue' });
  saveCalendarEvent({ text: 'Too far away', day: '2026-11-12', color: 'green' });
  render(UpcomingCalendar);
  expect(screen.queryByText('Too far away')).toBeNull();
  await fireEvent.click(screen.getByRole('button', { name: /This week/ }));
  expect(appStore.showCalendar).toHaveBeenCalledWith(new Date(2026, 10, 6));
});

it('subscribes to a calendar and shows the source of a continuing event', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 5, 12));
  const empty: CalendarSyncSnapshot = { providers: { google: false, outlook: false }, calendars: [] };
  const added: CalendarSyncSnapshot = {
    ...empty, calendars: [{
      id: 'fixture', name: 'Work', provider: 'link', lastSynced: Date.now(),
      events: [{ id: 'trip', title: 'Team offsite', start: '2026-11-04', end: '2026-11-06' }]
    }]
  };
  let current = empty;
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'calendar_sync_add_link') current = added;
    return current;
  });
  const api = window.electronAPI;
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { isElectron: true, invoke, on: () => () => {} } });
  try {
    render(CalendarScreen);
    await fireEvent.click(screen.getByRole('button', { name: 'Add calendar' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByRole('button', { name: 'Google Calendar' }).hasAttribute('disabled')).toBe(true);
    await fireEvent.click(dialog.getByRole('button', { name: 'Subscribe by link' }));
    await fireEvent.input(dialog.getByLabelText('Calendar link'), { target: { value: 'https://calendar.example.com/work.ics' } });
    await fireEvent.submit(document.getElementById('calendar-link-form')!);
    expect(await dialog.findByText('Work')).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith('calendar_sync_add_link', { name: '', url: 'https://calendar.example.com/work.ics' });
    await fireEvent.click(dialog.getByRole('button', { name: 'Close' }));
    const agenda = within(screen.getByRole('region', { name: 'Thursday, November 5, 2026' }));
    expect(agenda.getByText('Team offsite')).toBeTruthy();
    expect(agenda.getByText('Work')).toBeTruthy();
  } finally {
    cleanup();
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: api });
  }
});

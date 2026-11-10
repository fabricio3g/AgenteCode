/**
 * Notes, to-dos, reminders and calendar events shared across Home.
 *
 * One small JSON document in localStorage (the same path the app's other
 * per-device stores use), so it survives restarts and is shared by every chat
 * but never leaves the machine. Reminders fire while the app runs: an in-app
 * toast, plus a system notification when permission was already granted.
 */

export type Note = { id: string; title: string; body: string; tags: string[]; createdAt: number; updatedAt: number };
export type Todo = { id: string; text: string; done: boolean; due?: string; createdAt: number; doneAt?: number };
export type Reminder = { id: string; text: string; fireAt: number; createdAt: number };
export const EVENT_COLORS = ['blue', 'green', 'amber', 'violet'] as const;
export type EventColor = typeof EVENT_COLORS[number];
export type CalendarEvent = { id: string; text: string; day: string; time?: string; color: EventColor };

type Doc = { notes: Note[]; todos: Todo[]; reminders: Reminder[]; events: CalendarEvent[] };

const STORAGE_KEY = 'agente.home.productivity.v1';
const MAX_ITEMS = 500;
export const HOME_PRODUCTIVITY_CHANGED = 'agente:home-productivity-changed';

function emptyDoc(): Doc {
  return { notes: [], todos: [], reminders: [], events: [] };
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function load(): Doc {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return emptyDoc();
    const parsed = JSON.parse(raw) as Partial<Doc>;
    return {
      notes: Array.isArray(parsed.notes) ? parsed.notes : [],
      todos: Array.isArray(parsed.todos) ? parsed.todos : [],
      reminders: Array.isArray(parsed.reminders) ? parsed.reminders : [],
      events: Array.isArray(parsed.events) ? parsed.events : []
    };
  } catch {
    return emptyDoc();
  }
}

function save(doc: Doc): boolean {
  try {
    const target = storage();
    if (!target) return false;
    target.setItem(STORAGE_KEY, JSON.stringify(doc));
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(HOME_PRODUCTIVITY_CHANGED));
    return true;
  } catch {
    return false;
  }
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function mutate<T>(fn: (doc: Doc) => T, requireStorage = false): T {
  const doc = load();
  const result = fn(doc);
  if (!save(doc) && requireStorage) throw new Error('Could not save calendar changes.');
  return result;
}

/** Wall-clock values stay on their chosen local day, including all-day events. */
export function localCalendarDate(day: string, time?: string): Date | null {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const clock = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time ?? '00:00');
  if (!date || !clock) return null;
  const [, year, month, dayOfMonth] = date.map(Number);
  const [, hour, minute] = clock.map(Number);
  if (year < 1) return null;
  const result = new Date(0);
  result.setFullYear(year, month - 1, dayOfMonth);
  result.setHours(hour, minute, 0, 0);
  if (result.getFullYear() !== year || result.getMonth() !== month - 1 || result.getDate() !== dayOfMonth) return null;
  if (time && (result.getHours() !== hour || result.getMinutes() !== minute)) return null;
  return result;
}

export function listCalendarEvents(): CalendarEvent[] {
  return load().events;
}

export function saveCalendarEvent(input: Omit<CalendarEvent, 'id'>, id?: string): CalendarEvent {
  const text = input.text.trim();
  if (!text || !localCalendarDate(input.day, input.time) || !EVENT_COLORS.includes(input.color)) {
    throw new Error('Invalid calendar event.');
  }
  return mutate(doc => {
    const index = id === undefined ? -1 : doc.events.findIndex(entry => entry.id === id);
    if (id !== undefined && index === -1) throw new Error('Event was removed.');
    if (index === -1 && doc.events.length >= MAX_ITEMS) throw new Error('Event limit reached.');
    const event = { ...input, text, id: id ?? newId('event') };
    if (index === -1) doc.events.push(event);
    else doc.events[index] = event;
    return event;
  }, true);
}

export function removeCalendarEvent(id: string): void {
  mutate(doc => { doc.events = doc.events.filter(entry => entry.id !== id); }, true);
}

// ── Notes ─────────────────────────────────────────────────────────────────

export function createNote(input: { title: string; body?: string; tags?: string[] }): Note {
  return mutate((doc) => {
    if (doc.notes.length >= MAX_ITEMS) throw new Error('Note limit reached; delete some notes first.');
    const now = Date.now();
    const note: Note = { id: newId('note'), title: input.title.trim() || 'Untitled', body: input.body ?? '', tags: cleanTags(input.tags), createdAt: now, updatedAt: now };
    doc.notes.unshift(note);
    return note;
  });
}

function cleanTags(tags?: string[]): string[] {
  return Array.isArray(tags) ? [...new Set(tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))].slice(0, 12) : [];
}

export function listNotes(filter: { query?: string; tag?: string } = {}): Array<Omit<Note, 'body'> & { preview: string }> {
  const query = filter.query?.trim().toLowerCase();
  const tag = filter.tag?.trim().toLowerCase();
  return load().notes
    .filter((note) => (!tag || note.tags.includes(tag)) && (!query || `${note.title}\n${note.body}`.toLowerCase().includes(query)))
    .map(({ body, ...rest }) => ({ ...rest, preview: body.replace(/\s+/g, ' ').slice(0, 160) }));
}

export function readNote(id: string): Note | null {
  return load().notes.find((note) => note.id === id) ?? null;
}

export function updateNote(id: string, patch: { title?: string; body?: string; append?: string; tags?: string[] }): Note | null {
  return mutate((doc) => {
    const note = doc.notes.find((entry) => entry.id === id);
    if (!note) return null;
    if (patch.title !== undefined) note.title = patch.title.trim() || note.title;
    if (patch.body !== undefined) note.body = patch.body;
    if (patch.append) note.body = note.body ? `${note.body}\n${patch.append}` : patch.append;
    if (patch.tags !== undefined) note.tags = cleanTags(patch.tags);
    note.updatedAt = Date.now();
    return note;
  });
}

export function deleteNote(id: string): boolean {
  return mutate((doc) => {
    const before = doc.notes.length;
    doc.notes = doc.notes.filter((note) => note.id !== id);
    return doc.notes.length < before;
  });
}

// ── To-dos ────────────────────────────────────────────────────────────────

export function addTodo(input: { text: string; due?: string }): Todo {
  return mutate((doc) => {
    if (doc.todos.length >= MAX_ITEMS) throw new Error('To-do limit reached; remove some items first.');
    const todo: Todo = { id: newId('todo'), text: input.text.trim(), done: false, createdAt: Date.now(), ...(input.due ? { due: input.due } : {}) };
    if (!todo.text) throw new Error('text is required');
    doc.todos.push(todo);
    return todo;
  });
}

export function listTodos(filter: { status?: 'open' | 'done' | 'all' } = {}): Todo[] {
  const status = filter.status ?? 'open';
  return load().todos.filter((todo) => status === 'all' || (status === 'done' ? todo.done : !todo.done));
}

export function setTodoDone(id: string, done = true): Todo | null {
  return mutate((doc) => {
    const todo = doc.todos.find((entry) => entry.id === id);
    if (!todo) return null;
    todo.done = done;
    todo.doneAt = done ? Date.now() : undefined;
    return todo;
  });
}

export function removeTodo(id: string): boolean {
  return mutate((doc) => {
    const before = doc.todos.length;
    doc.todos = doc.todos.filter((todo) => todo.id !== id);
    return doc.todos.length < before;
  });
}

// ── Reminders ─────────────────────────────────────────────────────────────

const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** setTimeout cannot hold more than ~24.8 days; longer waits re-arm in chunks. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

type Notifier = (reminder: Reminder) => void;
let notifier: Notifier = () => {};

/** Where a due reminder is shown. The app wires toast + Notification at startup. */
export function setReminderNotifier(next: Notifier): void {
  notifier = next;
}

function arm(reminder: Reminder): void {
  const existing = timers.get(reminder.id);
  if (existing) clearTimeout(existing);
  const wait = reminder.fireAt - Date.now();
  if (wait <= 0) {
    fire(reminder.id);
    return;
  }
  timers.set(reminder.id, setTimeout(() => (reminder.fireAt - Date.now() > 1000 ? arm(reminder) : fire(reminder.id)), Math.min(wait, MAX_TIMEOUT_MS)));
}

function fire(id: string): void {
  timers.delete(id);
  const reminder = mutate((doc) => {
    const found = doc.reminders.find((entry) => entry.id === id);
    doc.reminders = doc.reminders.filter((entry) => entry.id !== id);
    return found;
  });
  if (reminder) notifier(reminder);
}

export function setReminder(input: { text: string; at?: string; inMinutes?: number }, now = Date.now()): Reminder {
  const text = input.text.trim();
  if (!text) throw new Error('text is required');
  let fireAt: number;
  if (typeof input.inMinutes === 'number' && Number.isFinite(input.inMinutes)) {
    fireAt = now + Math.round(input.inMinutes * 60_000);
  } else if (input.at) {
    fireAt = new Date(input.at).getTime();
    if (Number.isNaN(fireAt)) throw new Error(`Invalid time: ${input.at} (use ISO 8601 with an offset, or in_minutes)`);
  } else {
    throw new Error('Provide in_minutes or at.');
  }
  if (fireAt <= now) throw new Error('The reminder time is in the past.');
  const reminder = mutate((doc) => {
    if (doc.reminders.length >= 100) throw new Error('Too many pending reminders.');
    const entry: Reminder = { id: newId('rem'), text, fireAt, createdAt: now };
    doc.reminders.push(entry);
    return entry;
  });
  arm(reminder);
  return reminder;
}

export function listReminders(): Reminder[] {
  return load().reminders.slice().sort((a, b) => a.fireAt - b.fireAt);
}

export function cancelReminder(id: string): boolean {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  return mutate((doc) => {
    const before = doc.reminders.length;
    doc.reminders = doc.reminders.filter((entry) => entry.id !== id);
    return doc.reminders.length < before;
  });
}

/** Re-arm every pending reminder after a restart; overdue ones fire now. */
export function startReminderScheduler(): void {
  for (const reminder of load().reminders) arm(reminder);
}

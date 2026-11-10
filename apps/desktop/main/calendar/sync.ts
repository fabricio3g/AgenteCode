import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow, safeStorage, type IpcMain } from 'electron';
import { z } from 'zod';
import type { CalendarAccountProvider, CalendarAccountSelection, CalendarSyncSnapshot, SyncedCalendar } from '../../shared/calendar-sync.ts';
import { getAppPaths } from '../paths.ts';
import { calendarSignInAvailable, listAccountCalendars, refreshCalendarGrant, signInCalendar, syncAccountCalendar, type CalendarGrant, type RemoteEvents } from './accounts.ts';
import { CalendarHttpError, calendarFeedUrl, fetchCalendarFeed } from './feed.ts';
import { parseCalendarFeed, syncWindow } from './ical.ts';

type Source = SyncedCalendar & RemoteEvents & {
  feed?: string;
  account?: string;
  remoteId?: string;
  etag?: string;
  modified?: string;
  retryAt?: number;
  failures?: number;
};
type Account = { id: string; provider: CalendarAccountProvider; grant: string };
type Saved = { calendars: Source[]; accounts: Account[] };
type Flow = {
  controller: AbortController;
  provider: CalendarAccountProvider;
  selection?: CalendarAccountSelection;
  grant?: CalendarGrant;
  expires: number;
  reconnect?: string;
};

const MAX_CALENDARS = 12;
const REFRESH_MS = 15 * 60_000;
const flights = new Map<string, { source: Source; controller: AbortController; task: Promise<void> }>();
const grants = new Map<string, Promise<CalendarGrant>>();
const flows = new Map<number, Flow>();
const manualAt = new Map<string, number>();
let saved: Saved | undefined;
let addingFeeds = 0;

function file() { return path.join(getAppPaths().appData, 'calendar-sources.json'); }
function data(): Saved {
  if (saved) return saved;
  try { saved = JSON.parse(fs.readFileSync(file(), 'utf8')) as Saved; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Could not read saved calendars.');
    saved = { calendars: [], accounts: [] };
  }
  return saved;
}

function persist(next: Saved) {
  const target = file();
  const temporary = target + '.tmp';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
  fs.renameSync(temporary, target);
  saved = next;
}

function ensureSecureStorage() {
  if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
    throw new Error('Unlock your system keyring before connecting a calendar.');
  }
}
function seal(value: string): string {
  ensureSecureStorage();
  return safeStorage.encryptString(value).toString('base64');
}
function unseal(value: string): string {
  try { return safeStorage.decryptString(Buffer.from(value, 'base64')); }
  catch { throw new CalendarHttpError(401); }
}

function snapshot(): CalendarSyncSnapshot {
  return {
    providers: { google: calendarSignInAvailable('google'), outlook: calendarSignInAvailable('outlook') },
    calendars: data().calendars.map(({ id, name, provider, lastSynced, error, events }) => ({ id, name, provider, lastSynced, error, events })),
  };
}
function changed() {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('calendar_sync_changed');
  }
}

function accountGrant(account: Account, force = false): Promise<CalendarGrant> {
  const running = grants.get(account.id);
  if (running) return running;
  const task = (async () => {
    const existing = JSON.parse(unseal(account.grant)) as CalendarGrant;
    if (!force && existing.expires > Date.now() + 60_000) return existing;
    const updated = await refreshCalendarGrant(account.provider, existing);
    if (data().accounts.includes(account)) {
      const grant = seal(JSON.stringify(updated));
      persist({ ...data(), accounts: data().accounts.map(item => item.id === account.id ? { ...item, grant } : item) });
    }
    return updated;
  })().finally(() => grants.delete(account.id));
  grants.set(account.id, task);
  return task;
}

async function linkEvents(url: string, previous?: Source, signal?: AbortSignal) {
  const month = new Date().toISOString().slice(0, 7);
  const validators = previous?.month === month ? { etag: previous.etag, modified: previous.modified } : {};
  const response = await fetchCalendarFeed(url, validators, signal);
  if (response.body === undefined) {
    if (!previous) throw new Error('The calendar feed returned no content.');
    return { events: previous.events, etag: previous.etag, modified: previous.modified, month, name: '' };
  }
  const { from, to } = syncWindow();
  const parsed = parseCalendarFeed(response.body, from, to);
  return { ...parsed, etag: response.etag, modified: response.modified, month };
}

function updateSource(source: Source, patch: Partial<Source>) {
  const current = data();
  if (current.calendars.includes(source)) {
    persist({ ...current, calendars: current.calendars.map(item => item === source ? { ...item, ...patch } : item) });
    changed();
  }
}

async function syncSource(source: Source, signal: AbortSignal) {
  try {
    let patch: RemoteEvents & Partial<Source>;
    if (source.provider === 'link' && source.feed) {
      const { name: _name, ...events } = await linkEvents(unseal(source.feed), source, signal);
      patch = events;
    } else if (source.provider !== 'link' && source.remoteId) {
      const account = data().accounts.find(item => item.id === source.account);
      if (!account) throw new CalendarHttpError(401);
      const grant = await accountGrant(account);
      try { patch = await syncAccountCalendar(source.provider, source.remoteId, grant, source, signal); }
      catch (error) {
        if (!(error instanceof CalendarHttpError) || error.status !== 401) throw error;
        const current = data().accounts.find(item => item.id === account.id);
        if (!current) return;
        patch = await syncAccountCalendar(source.provider, source.remoteId, await accountGrant(current, true), source, signal);
      }
    } else throw new CalendarHttpError(401);
    updateSource(source, { ...patch, lastSynced: Date.now(), error: undefined, retryAt: undefined, failures: undefined });
  } catch (error) {
    if (signal.aborted) return;
    const response = error instanceof CalendarHttpError ? error : undefined;
    const status = response?.status;
    const kind = status === 401 || status === 403 ? (source.provider === 'link' ? 'unavailable' : 'signIn')
      : status === 429 ? 'limited' : status === 404 || status === 410 ? 'unavailable' : 'offline';
    const failures = (source.failures ?? 0) + 1;
    const backoff = Math.min(4 * 60 * 60_000, 2 ** Math.min(failures, 6) * 60_000);
    updateSource(source, { error: kind, failures, retryAt: Math.max(Date.now() + backoff, response?.retryAt ?? 0) });
  }
}

function schedule(source: Source, manual = false): Promise<void> {
  const running = flights.get(source.id);
  if (running?.source === source) return running.task;
  running?.controller.abort();
  if (!manual && source.error === 'signIn') return Promise.resolve();
  const now = Date.now();
  if (source.retryAt && source.retryAt > now && (!manual || source.error === 'limited')) return Promise.resolve();
  if (manual && (manualAt.get(source.id) ?? 0) > now - 15_000) return Promise.resolve();
  if (!manual && (source.lastSynced ?? 0) > now - REFRESH_MS && !source.error) return Promise.resolve();
  if (manual) manualAt.set(source.id, now);
  const controller = new AbortController();
  const task = syncSource(source, controller.signal).finally(() => {
    if (flights.get(source.id)?.controller === controller) flights.delete(source.id);
  });
  flights.set(source.id, { source, controller, task });
  return task;
}

function backgroundRefresh() {
  for (const [owner, flow] of flows) if (Date.now() > flow.expires) {
    flow.controller.abort();
    flows.delete(owner);
  }
  try {
    for (const source of data().calendars) void schedule(source).catch(() => {});
  } catch { /* Unreadable configuration is reported when Calendar is opened. */ }
}

const id = () => crypto.randomUUID();
const providerSchema = z.enum(['google', 'outlook']);
const idSchema = z.string().uuid();
const linkSchema = z.object({ url: z.string().trim().min(1).max(4096), name: z.string().trim().max(80).optional() });
const selectionSchema = z.object({ session: idSchema, calendarIds: z.array(z.string().min(1).max(2048)).min(1).max(MAX_CALENDARS) });
const signInSchema = z.object({ provider: providerSchema, reconnect: idSchema.optional() });

function cancelFlow(owner: number) {
  flows.get(owner)?.controller.abort();
  flows.delete(owner);
}

export function registerCalendarSyncHandlers(ipc: IpcMain) {
  const timer = setInterval(backgroundRefresh, 60_000);
  timer.unref();
  ipc.handle('calendar_sync_list', () => {
    backgroundRefresh();
    return snapshot();
  });
  ipc.handle('calendar_sync_add_link', async (_event, input: unknown) => {
    const request = linkSchema.safeParse(input);
    if (!request.success) throw new Error('Check the calendar link and name.');
    const url = calendarFeedUrl(request.data.url).href;
    ensureSecureStorage();
    if (data().calendars.length + addingFeeds >= MAX_CALENDARS) throw new Error('Calendar limit reached.');
    const alreadyConnected = () => data().calendars.some(source => {
      try { return !!source.feed && unseal(source.feed) === url; }
      catch { return false; }
    });
    addingFeeds++;
    try {
      if (alreadyConnected()) throw new Error('This calendar link is already connected.');
      let result: Awaited<ReturnType<typeof linkEvents>>;
      try { result = await linkEvents(url); }
      catch { throw new Error('Could not read this calendar. Check that the link opens a public HTTPS iCalendar feed.'); }
      if (alreadyConnected()) throw new Error('This calendar link is already connected.');
      const current = data();
      const source: Source = {
        ...result, id: id(), provider: 'link', name: request.data.name || result.name || 'Subscribed calendar',
        feed: seal(url), lastSynced: Date.now(),
      };
      if (current.calendars.length >= MAX_CALENDARS) throw new Error('Calendar limit reached.');
      persist({ ...current, calendars: [...current.calendars, source] });
      changed();
      return snapshot();
    } finally { addingFeeds--; }
  });
  ipc.handle('calendar_sync_sign_in', async (event, input: unknown) => {
    const request = signInSchema.safeParse(input);
    if (!request.success) throw new Error('Choose Google Calendar or Outlook.');
    const { provider, reconnect } = request.data;
    const source = reconnect ? data().calendars.find(calendar => calendar.id === reconnect && calendar.provider === provider) : undefined;
    if (reconnect && !source?.remoteId) throw new Error('This calendar is no longer connected.');
    ensureSecureStorage();
    const owner = event.sender.id;
    cancelFlow(owner);
    const flow: Flow = { controller: new AbortController(), provider, reconnect, expires: Date.now() + 10 * 60_000 };
    flows.set(owner, flow);
    const cancel = () => { if (flows.get(owner) === flow) cancelFlow(owner); };
    event.sender.once('destroyed', cancel);
    try {
      flow.grant = await signInCalendar(flow.provider, flow.controller.signal);
      let calendars = await listAccountCalendars(flow.provider, flow.grant, flow.controller.signal);
      if (source) {
        calendars = calendars.filter(calendar => calendar.id === source.remoteId);
        if (!calendars.length) throw new Error('This account no longer has access to the calendar.');
      }
      if (flow.controller.signal.aborted) throw new Error('Calendar sign-in was cancelled.');
      flow.selection = { session: id(), calendars };
      return flow.selection;
    } catch (error) {
      cancel();
      if (error instanceof CalendarHttpError) throw new Error('The provider could not grant access. Check the account or try again.');
      throw error;
    } finally {
      if (!event.sender.isDestroyed()) event.sender.removeListener('destroyed', cancel);
    }
  });
  ipc.handle('calendar_sync_cancel_sign_in', event => cancelFlow(event.sender.id));
  ipc.handle('calendar_sync_select', (event, input: unknown) => {
    const request = selectionSchema.safeParse(input);
    const flow = flows.get(event.sender.id);
    if (!request.success || !flow?.grant || !flow.selection || request.data.session !== flow.selection.session || Date.now() > flow.expires) {
      throw new Error('Sign in again to choose calendars.');
    }
    const selected = new Set(request.data.calendarIds);
    const choices = flow.selection.calendars.filter(calendar => selected.has(calendar.id));
    if (choices.length !== selected.size) throw new Error('Select calendars from the signed-in account.');
    const current = data();
    if (flow.reconnect && !current.calendars.some(calendar => calendar.id === flow.reconnect)) throw new Error('This calendar was removed.');
    const existing = current.calendars.filter(calendar => calendar.provider === flow.provider && calendar.remoteId && selected.has(calendar.remoteId));
    if (current.calendars.length + choices.length - existing.length > MAX_CALENDARS) throw new Error('Calendar limit reached.');
    const account: Account = { id: id(), provider: flow.provider, grant: seal(JSON.stringify(flow.grant)) };
    const sources: Source[] = choices.map(calendar => ({
      id: existing.find(item => item.remoteId === calendar.id)?.id ?? id(),
      name: calendar.name, provider: flow.provider, account: account.id, remoteId: calendar.id, events: [],
    }));
    const calendars = [...current.calendars.filter(calendar => !existing.includes(calendar)), ...sources];
    const accounts = [...current.accounts, account].filter(item => calendars.some(calendar => calendar.account === item.id));
    persist({ calendars, accounts });
    cancelFlow(event.sender.id);
    changed();
    for (const source of sources) void schedule(source).catch(() => {});
    return snapshot();
  });
  ipc.handle('calendar_sync_refresh', async (_event, input: unknown) => {
    const sourceId = idSchema.safeParse(input && (input as { id?: unknown }).id);
    if (!sourceId.success) throw new Error('Choose a calendar to refresh.');
    const source = data().calendars.find(item => item.id === sourceId.data);
    if (source) await schedule(source, true);
    return snapshot();
  });
  ipc.handle('calendar_sync_remove', (_event, input: unknown) => {
    const sourceId = idSchema.safeParse(input && (input as { id?: unknown }).id);
    if (!sourceId.success) throw new Error('Choose a calendar to remove.');
    const current = data();
    const calendars = current.calendars.filter(item => item.id !== sourceId.data);
    persist({ calendars, accounts: current.accounts.filter(account => calendars.some(calendar => calendar.account === account.id)) });
    flights.get(sourceId.data)?.controller.abort();
    manualAt.delete(sourceId.data);
    changed();
    return snapshot();
  });
}

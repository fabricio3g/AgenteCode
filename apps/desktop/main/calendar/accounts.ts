import crypto from 'node:crypto';
import { createServer } from 'node:http';
import { shell } from 'electron';
import type { CalendarAccountProvider, CalendarAccountSelection, SyncedCalendarEvent } from '../../shared/calendar-sync.ts';
import { CalendarHttpError, retryAfter } from './feed.ts';
import { MAX_EVENTS, syncWindow } from './ical.ts';

export interface CalendarGrant {
  access: string;
  refresh: string;
  expires: number;
}

const GOOGLE_API = 'https://www.googleapis.com';
const GRAPH_API = 'https://graph.microsoft.com';
const config = {
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.readonly',
    client: () => process.env.AGENTE_GOOGLE_CALENDAR_CLIENT_ID?.trim(),
    secret: () => process.env.AGENTE_GOOGLE_CALENDAR_CLIENT_SECRET?.trim(),
  },
  outlook: {
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'offline_access https://graph.microsoft.com/Calendars.ReadBasic',
    client: () => process.env.AGENTE_OUTLOOK_CALENDAR_CLIENT_ID?.trim(),
    secret: () => undefined,
  },
};

export function calendarSignInAvailable(provider: CalendarAccountProvider): boolean {
  return !!config[provider].client() && (provider !== 'google' || !!config.google.secret());
}

async function exchange(provider: CalendarAccountProvider, parameters: Record<string, string>, oldRefresh = '', signal?: AbortSignal): Promise<CalendarGrant> {
  const settings = config[provider];
  const client = settings.client();
  if (!client) throw new CalendarHttpError(401);
  const secret = settings.secret();
  const response = await fetch(settings.token, {
    method: 'POST',
    redirect: 'error',
    body: new URLSearchParams({ client_id: client, ...(secret && { client_secret: secret }), ...parameters }),
    signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
  });
  const data = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
  if (!response.ok) throw new CalendarHttpError(data.error === 'invalid_grant' || data.error === 'invalid_client' ? 401 : response.status, retryAfter(response.headers.get('retry-after')));
  if (!data.access_token || !(data.refresh_token || oldRefresh)) throw new CalendarHttpError(401);
  return { access: data.access_token, refresh: data.refresh_token || oldRefresh, expires: Date.now() + (data.expires_in ?? 3600) * 1000 };
}

export function refreshCalendarGrant(provider: CalendarAccountProvider, grant: CalendarGrant): Promise<CalendarGrant> {
  return exchange(provider, { grant_type: 'refresh_token', refresh_token: grant.refresh }, grant.refresh);
}

export async function signInCalendar(provider: CalendarAccountProvider, cancel: AbortSignal): Promise<CalendarGrant> {
  if (!calendarSignInAvailable(provider)) throw new Error('Account sign-in is unavailable in this build. You can subscribe by link.');
  const signal = AbortSignal.any([cancel, AbortSignal.timeout(150_000)]);
  const state = crypto.randomBytes(32).toString('base64url');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  let accept!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => { accept = resolve; rejectCode = reject; });
  void code.catch(() => {});
  const abort = () => rejectCode(new Error('Calendar sign-in was cancelled or timed out.'));
  const server = createServer((request, response) => {
    let url: URL;
    try { url = new URL(request.url ?? '/', 'http://127.0.0.1'); }
    catch { response.writeHead(400).end(); return; }
    if (request.method !== 'GET' || url.pathname !== '/callback' || url.searchParams.get('state') !== state) {
      response.writeHead(404).end();
      return;
    }
    const value = url.searchParams.get('code');
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' })
      .end(value ? 'Sign-in received. Return to Agente to choose calendars.' : 'Sign-in was declined. Return to Agente to try again.');
    if (value) accept(value);
    else rejectCode(new Error('Calendar access was declined.'));
  });
  server.on('error', () => rejectCode(new Error('Could not start the calendar sign-in listener.')));
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    await Promise.race([new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)), code]);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Could not start calendar sign-in.');
    const redirect = `http://127.0.0.1:${address.port}/callback`;
    const settings = config[provider];
    const url = new URL(settings.authorize);
    url.search = new URLSearchParams({
      client_id: settings.client()!,
      response_type: 'code', redirect_uri: redirect, scope: settings.scope,
      state, code_challenge: challenge, code_challenge_method: 'S256',
      ...(provider === 'google' ? { access_type: 'offline', prompt: 'consent' } : { prompt: 'select_account' }),
    }).toString();
    await shell.openExternal(url.href);
    return await exchange(provider, { grant_type: 'authorization_code', code: await code, code_verifier: verifier, redirect_uri: redirect }, '', signal);
  } finally {
    signal.removeEventListener('abort', abort);
    server.close();
    server.closeAllConnections();
  }
}

async function getPage<T>(url: URL, access: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    redirect: 'error',
    headers: { Authorization: `Bearer ${access}` },
    signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
  });
  if (!response.ok) {
    let status = response.status;
    if (status === 403 && url.origin === GOOGLE_API) {
      const data = await response.json().catch(() => null) as { error?: { errors?: { reason: string }[] } } | null;
      if (data?.error?.errors?.some(error => /rateLimitExceeded|quotaExceeded/i.test(error.reason))) status = 429;
    }
    throw new CalendarHttpError(status, retryAfter(response.headers.get('retry-after')));
  }
  return await response.json() as T;
}

type GoogleCalendar = { id: string; summary?: string; summaryOverride?: string; primary?: boolean; accessRole?: string };
type GraphCalendar = { id: string; name?: string; isDefaultCalendar?: boolean };
type GooglePage<T> = { items?: T[]; nextPageToken?: string; nextSyncToken?: string };
type GraphPage<T> = { value?: T[]; '@odata.nextLink'?: string };

async function googlePages<T>(url: URL, access: string, signal?: AbortSignal): Promise<{ items: T[]; token?: string }> {
  const items: T[] = [];
  for (let page = 0; page < 60; page++) {
    const result = await getPage<GooglePage<T>>(url, access, signal);
    items.push(...(result.items ?? []));
    if (items.length > MAX_EVENTS) break;
    if (!result.nextPageToken) return { items, token: result.nextSyncToken };
    url.searchParams.set('pageToken', result.nextPageToken);
  }
  throw new Error('Calendar response exceeds the sync limit.');
}

async function graphPages<T>(url: URL, access: string, signal?: AbortSignal): Promise<T[]> {
  const items: T[] = [];
  for (let page = 0; page < 60; page++) {
    if (url.origin !== GRAPH_API) throw new Error('Invalid calendar page.');
    const result = await getPage<GraphPage<T>>(url, access, signal);
    items.push(...(result.value ?? []));
    if (items.length > MAX_EVENTS) break;
    if (!result['@odata.nextLink']) return items;
    url = new URL(result['@odata.nextLink']);
  }
  throw new Error('Calendar response exceeds the sync limit.');
}

export async function listAccountCalendars(provider: CalendarAccountProvider, grant: CalendarGrant, signal?: AbortSignal): Promise<CalendarAccountSelection['calendars']> {
  if (provider === 'google') {
    const url = new URL('/calendar/v3/users/me/calendarList?minAccessRole=reader', GOOGLE_API);
    const { items } = await googlePages<GoogleCalendar>(url, grant.access, signal);
    return items.map(item => ({ id: item.id, name: (item.summaryOverride || item.summary || 'Calendar').slice(0, 80), primary: item.primary }));
  }
  const url = new URL('/v1.0/me/calendars?$select=id,name,isDefaultCalendar', GRAPH_API);
  const calendars = await graphPages<GraphCalendar>(url, grant.access, signal);
  return calendars.map(item => ({ id: item.id, name: (item.name || 'Calendar').slice(0, 80), primary: item.isDefaultCalendar }));
}

type GoogleEvent = {
  id: string; summary?: string; status?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
};
type GraphEvent = {
  id: string; subject?: string; isAllDay?: boolean; isCancelled?: boolean;
  start?: { dateTime?: string }; end?: { dateTime?: string };
};
export type RemoteEvents = { events: SyncedCalendarEvent[]; syncToken?: string; month?: string };

function graphDate(value: string | undefined, allDay: boolean): string | undefined {
  if (!value) return;
  if (allDay) return value.slice(0, 10);
  const date = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : value + 'Z');
  if (Number.isFinite(date.getTime())) return date.toISOString();
}

export async function syncAccountCalendar(provider: CalendarAccountProvider, calendarId: string, grant: CalendarGrant, previous: RemoteEvents, signal: AbortSignal): Promise<RemoteEvents> {
  const { from, to } = syncWindow();
  if (provider === 'outlook') {
    const url = new URL(`/v1.0/me/calendars/${encodeURIComponent(calendarId)}/calendarView`, GRAPH_API);
    url.search = new URLSearchParams({
      startDateTime: from.toISOString(), endDateTime: to.toISOString(),
      $select: 'id,subject,isAllDay,isCancelled,start,end',
    }).toString();
    const items = await graphPages<GraphEvent>(url, grant.access, signal);
    return { events: items.flatMap(item => {
      const start = graphDate(item.start?.dateTime, !!item.isAllDay);
      return start && !item.isCancelled ? [{ id: item.id, title: (item.subject || '').slice(0, 500), start, end: graphDate(item.end?.dateTime, !!item.isAllDay) }] : [];
    }) };
  }

  const month = new Date().toISOString().slice(0, 7);
  const syncToken = previous.month === month ? previous.syncToken : undefined;
  const url = new URL(`/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, GOOGLE_API);
  url.search = new URLSearchParams({
    singleEvents: 'true', showDeleted: 'true', maxResults: '500',
    fields: 'nextPageToken,nextSyncToken,items(id,summary,status,start,end)',
    ...(syncToken ? { syncToken } : { timeMin: from.toISOString(), timeMax: to.toISOString() }),
  }).toString();
  let response: Awaited<ReturnType<typeof googlePages<GoogleEvent>>>;
  try { response = await googlePages<GoogleEvent>(url, grant.access, signal); }
  catch (error) {
    if (syncToken && error instanceof CalendarHttpError && error.status === 410) {
      return syncAccountCalendar(provider, calendarId, grant, { events: [] }, signal);
    }
    throw error;
  }
  const events = new Map((syncToken ? previous.events : []).map(item => [item.id, item]));
  for (const item of response.items) {
    const start = item.start?.date || item.start?.dateTime;
    if (!start || item.status === 'cancelled') events.delete(item.id);
    else events.set(item.id, { id: item.id, title: (item.summary || '').slice(0, 500), start, end: item.end?.date || item.end?.dateTime });
  }
  return {
    events: [...events.values()].filter(item => new Date(item.start) < to && new Date(item.end || item.start) >= from),
    syncToken: response.token,
    month,
  };
}

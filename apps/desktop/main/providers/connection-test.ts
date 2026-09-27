// ── "Test connection" for a provider ───────────────────────────────────
// The catalog helpers swallow failures (a missing list must never break a
// chat), which is useless for telling someone why their key does not work.
// This asks the endpoint directly and names the failure.

import type { Dialect } from './dialects.ts';

export type ConnectionFailure = 'no_key' | 'auth' | 'not_found' | 'rate_limited' | 'server' | 'unreachable' | 'bad_response';

export type ConnectionResult =
  | { ok: true; models: string[] }
  | { ok: false; reason: ConnectionFailure; status?: number; detail?: string };

function reasonForStatus(status: number): ConnectionFailure {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  return 'server';
}

function baseOf(dialect: Dialect | undefined, baseUrl: string): string {
  const raw = dialect?.normalizeBaseUrl ? dialect.normalizeBaseUrl(baseUrl) : baseUrl;
  return String(raw || dialect?.defaultBaseUrl || '').trim().replace(/\/+$/, '');
}

export async function testProviderConnection(args: {
  dialect?: Dialect;
  baseUrl: string;
  apiKey: string;
  requireKey: boolean;
  fetchImpl?: typeof fetch;
}): Promise<ConnectionResult> {
  const { dialect, apiKey, requireKey } = args;
  const doFetch = args.fetchImpl ?? fetch;
  if (requireKey && !apiKey) return { ok: false, reason: 'no_key' };
  const base = baseOf(dialect, args.baseUrl);
  if (!base) return { ok: false, reason: 'unreachable', detail: 'No base URL' };
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...(dialect?.headers ? dialect.headers(apiKey) : {})
  };

  const get = async (path: string) => {
    try {
      return await doFetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  };

  if (dialect?.keyCheckPath && apiKey) {
    const check = await get(dialect.keyCheckPath);
    if (check instanceof Error) return { ok: false, reason: 'unreachable', detail: check.message };
    if (!check.ok) return { ok: false, reason: reasonForStatus(check.status), status: check.status };
  }

  const res = await get('/models');
  if (res instanceof Error) return { ok: false, reason: 'unreachable', detail: res.message };
  if (!res.ok) return { ok: false, reason: reasonForStatus(res.status), status: res.status };
  const data = await res.json().catch(() => null) as { data?: unknown; models?: unknown } | null;
  const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : null;
  if (!list) return { ok: false, reason: 'bad_response' };
  const models = list
    .map((entry) => String((entry as { id?: unknown })?.id ?? ''))
    .filter(Boolean)
    .sort();
  return { ok: true, models };
}

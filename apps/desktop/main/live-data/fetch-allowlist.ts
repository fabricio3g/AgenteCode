/** Allowlisted hosts for live-data tools (SSRF-safe). */
import { APP_USER_AGENT } from '../../shared/brand.ts';

const ALLOWED_HOSTS = new Set([
  'api.open-meteo.com',
  'geocoding-api.open-meteo.com',
  'api.frankfurter.dev',
  'www.frankfurter.app',
  'api.frankfurter.app',
  'stooq.com',
  'api.coingecko.com'
]);

function assertAllowedLiveDataUrl(urlString: string): URL {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error('Invalid live-data URL');
  }
  if (url.protocol !== 'https:') {
    throw new Error('Live-data requests must use HTTPS');
  }
  if (!ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error(`Host not allowed for live data: ${url.hostname}`);
  }
  return url;
}

export async function fetchLiveJson(urlString: string, timeoutMs = 12000): Promise<unknown> {
  const url = assertAllowedLiveDataUrl(urlString);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': `${APP_USER_AGENT} (live-data)` },
      signal: controller.signal
    });
    if (!res.ok) {
      throw new Error(`Live data HTTP ${res.status} for ${url.hostname}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchLiveText(urlString: string, timeoutMs = 12000): Promise<string> {
  const url = assertAllowedLiveDataUrl(urlString);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'text/csv,text/plain,*/*', 'User-Agent': `${APP_USER_AGENT} (live-data)` },
      signal: controller.signal
    });
    if (!res.ok) {
      throw new Error(`Live data HTTP ${res.status} for ${url.hostname}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

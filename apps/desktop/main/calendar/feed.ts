import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

const excluded = new BlockList();
for (const [network, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) excluded.addSubnet(network, bits, 'ipv4');
const globalIpv6 = new BlockList();
globalIpv6.addSubnet('2000::', 3, 'ipv6');
excluded.addSubnet('2001::', 32, 'ipv6');
excluded.addSubnet('2002::', 16, 'ipv6');

export function calendarFeedUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input.trim().replace(/^webcal:/i, 'https:')); }
  catch { throw new Error('Enter a valid calendar link.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) {
    throw new Error('Use a public HTTPS or webcal calendar link.');
  }
  return url;
}

export class CalendarHttpError extends Error {
  constructor(readonly status: number, readonly retryAt?: number) {
    super(`Calendar service returned HTTP ${status}.`);
  }
}

export function retryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = /^\d+$/.test(value) ? Date.now() + Number(value) * 1000 : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

type FeedResult = { body?: string; etag?: string; modified?: string; redirect?: string };
const MAX_FEED_BYTES = 4 * 1024 * 1024;

async function readFeed(url: URL, validators: { etag?: string; modified?: string }, signal: AbortSignal): Promise<FeedResult> {
  signal.throwIfAborted();
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literal = isIP(hostname);
  const addresses = literal ? [{ address: hostname, family: literal }] : await lookup(hostname, { all: true });
  const publicAddress = ({ address, family }: typeof addresses[number]) =>
    family === 4 ? !excluded.check(address, 'ipv4') : globalIpv6.check(address, 'ipv6') && !excluded.check(address, 'ipv6');
  if (!addresses.length || addresses.some(address => !publicAddress(address))) {
    throw new Error('The calendar link must point to a public server.');
  }
  const { address, family } = addresses[0];
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      family,
      agent: false,
      // Pin the address checked above so DNS changes cannot turn the fetch into a local request.
      lookup: (_host, _options, callback) => callback(null, address, family),
      signal,
      headers: {
        Accept: 'text/calendar, */*;q=0.1',
        ...(validators.etag && { 'If-None-Match': validators.etag }),
        ...(validators.modified && { 'If-Modified-Since': validators.modified }),
      },
    }, response => {
      const status = response.statusCode ?? 0;
      const redirect = response.headers.location;
      if (status === 304 || ([301, 302, 303, 307, 308].includes(status) && redirect)) {
        response.destroy();
        resolve(status === 304 ? {} : { redirect });
        return;
      }
      if (status !== 200) {
        response.destroy();
        reject(new CalendarHttpError(status, retryAfter(response.headers['retry-after'])));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_FEED_BYTES) {
          response.destroy(new Error('Calendar feed exceeds the size limit.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8'), etag: response.headers.etag, modified: response.headers['last-modified'] }));
    });
    request.on('error', reject);
  });
}

export async function fetchCalendarFeed(input: string, validators: { etag?: string; modified?: string } = {}, cancel?: AbortSignal): Promise<FeedResult> {
  const timeout = AbortSignal.timeout(15_000);
  const signal = cancel ? AbortSignal.any([cancel, timeout]) : timeout;
  let url = calendarFeedUrl(input);
  for (let hop = 0; hop < 4; hop++) {
    const result = await readFeed(url, validators, signal);
    if (!result.redirect) return result;
    const next = calendarFeedUrl(new URL(result.redirect, url).href);
    if (next.origin !== url.origin) validators = {};
    url = next;
  }
  throw new Error('The calendar link redirects too many times.');
}

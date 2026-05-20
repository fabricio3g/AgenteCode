import type { ModelOption } from '../types/chat';
import { buildLocalModelSecondaryText, formatContextLength } from './local-models';

export interface DeveloperConsoleEntry {
  id: string;
  method: string;
  path: string;
  status: number;
  timingMs: number;
  request: string;
  response: string;
  createdAt: number;
}

export interface DeveloperApiInfo {
  baseUrl: string;
  apiRoot: string;
  clientBaseUrl: string;
  clientApiRoot: string;
  host: string;
  port: number;
  shareableBaseUrl: string;
}

export function buildDeveloperModelMetadataLine(model: Pick<ModelOption, 'architecture' | 'quantization_name' | 'size_label' | 'context_length' | 'details'>): string {
  const base = buildLocalModelSecondaryText(model);
  const context = formatContextLength(model.context_length);
  return [base, context ? `${context} context` : ''].filter(Boolean).join(' / ');
}

export function developerModelMatchesSearch(
  model: Pick<ModelOption, 'id' | 'name' | 'architecture' | 'quantization_name' | 'size_label' | 'details'>,
  query: string
): boolean {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return true;
  return [model.id, model.name, model.architecture, model.quantization_name, model.size_label, model.details]
    .map((value) => String(value || '').toLowerCase())
    .some((value) => value.includes(needle));
}

export function createDeveloperConsoleEntry(args: {
  method: string;
  path: string;
  status?: number;
  request: unknown;
  response: unknown;
  startedAt?: number;
  endedAt?: number;
}): DeveloperConsoleEntry {
  const startedAt = args.startedAt ?? Date.now();
  const endedAt = args.endedAt ?? startedAt;
  return {
    id: `console-${startedAt}-${Math.random().toString(36).slice(2, 7)}`,
    method: args.method.toUpperCase(),
    path: args.path,
    status: args.status ?? 200,
    timingMs: Math.max(0, endedAt - startedAt),
    request: typeof args.request === 'string' ? args.request : JSON.stringify(args.request, null, 2),
    response: typeof args.response === 'string' ? args.response : JSON.stringify(args.response, null, 2),
    createdAt: endedAt
  };
}

export function parseDeveloperApiInfo(rawBaseUrl: string): DeveloperApiInfo {
  const fallback = 'http://127.0.0.1:11435/v1';
  let url: URL;
  try {
    url = new URL(String(rawBaseUrl || fallback));
  } catch {
    url = new URL(fallback);
  }

  const pathname = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
  const normalizedPath = pathname || '/v1';
  const apiRoot = `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}${normalizedPath}`;
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  const shareableHost = url.hostname === '0.0.0.0' ? '<your-lan-ip>' : url.hostname;
  const clientHost = url.hostname === '0.0.0.0' ? '127.0.0.1' : url.hostname;
  const clientApiRoot = `${url.protocol}//${clientHost}${url.port ? `:${url.port}` : ''}${normalizedPath}`;

  return {
    baseUrl: apiRoot,
    apiRoot,
    clientBaseUrl: clientApiRoot,
    clientApiRoot,
    host: url.hostname,
    port,
    shareableBaseUrl: `${url.protocol}//${shareableHost}${url.port ? `:${url.port}` : ''}${normalizedPath}`
  };
}

export function replaceDeveloperApiHost(rawBaseUrl: string, host: string): string {
  const fallback = 'http://127.0.0.1:11435/v1';
  let url: URL;
  try {
    url = new URL(String(rawBaseUrl || fallback));
  } catch {
    url = new URL(fallback);
  }
  url.hostname = host;
  return url.toString().replace(/\/+$/, '');
}

export interface DeveloperModelOption {
  id: string;
  name: string;
  architecture?: string;
  quantization_name?: string;
  size_label?: string;
  details?: string;
}

export interface DeveloperConsoleEntry {
  method: string;
  path: string;
  status: number;
  request: string;
  response: string;
  timingMs: number;
  timestamp: number;
}

export interface DeveloperApiInfo {
  host: string;
  port: number;
  apiRoot: string;
  clientApiRoot: string;
  shareableBaseUrl: string;
}

export function buildDeveloperModelMetadataLine(model: DeveloperModelOption): string {
  return [model.architecture, model.quantization_name, model.size_label, model.details]
    .filter(Boolean)
    .join(' · ');
}

export function developerModelMatchesSearch(model: DeveloperModelOption, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [
    model.id,
    model.name,
    model.architecture,
    model.quantization_name,
    model.size_label,
    model.details,
  ].filter(Boolean).join(' ').toLowerCase().includes(needle);
}

function stringifyPayload(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? '');
  }
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
  const endedAt = args.endedAt ?? Date.now();
  return {
    method: String(args.method || 'GET').toUpperCase(),
    path: args.path,
    status: args.status ?? 200,
    request: stringifyPayload(args.request),
    response: stringifyPayload(args.response),
    timingMs: Math.max(0, endedAt - startedAt),
    timestamp: endedAt,
  };
}

export function parseDeveloperApiInfo(rawBaseUrl: string): DeveloperApiInfo {
  const parsed = new URL(rawBaseUrl || 'http://127.0.0.1:11435/v1');
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  const apiRoot = parsed.toString().replace(/\/$/, '');
  const client = new URL(parsed);
  if (client.hostname === '0.0.0.0' || client.hostname === '::') client.hostname = '127.0.0.1';
  const shareable = new URL(parsed);
  const sharedHost = parsed.hostname === '0.0.0.0' || parsed.hostname === '::';
  return {
    host: parsed.hostname,
    port,
    apiRoot,
    clientApiRoot: client.toString().replace(/\/$/, ''),
    shareableBaseUrl: sharedHost
      ? `${parsed.protocol}//<your-lan-ip>${parsed.port ? `:${parsed.port}` : ''}${parsed.pathname.replace(/\/$/, '')}`
      : apiRoot,
  };
}

export function replaceDeveloperApiHost(rawBaseUrl: string, host: string): string {
  const parsed = new URL(rawBaseUrl);
  parsed.hostname = host;
  return parsed.toString().replace(/\/$/, '');
}

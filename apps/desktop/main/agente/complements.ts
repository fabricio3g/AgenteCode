import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { safeStorage, type IpcMain } from 'electron';
import { z } from 'zod';
import type { Complement, ComplementChange, ComplementSettings } from '../../shared/complements.ts';
import type { AgenteClient } from '../agente-client.ts';
import { getAppPaths } from '../paths.ts';
import { runtimeConnection } from './rust-engine.ts';

type Stored = ComplementSettings & { id: string; enabled: boolean; credentials?: string };
type Status = Record<string, Pick<Complement, 'status' | 'tools' | 'toolNames'>>;
const idSchema = z.string().regex(/^[a-f0-9]{12}$/);
const changeSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('save'), id: idSchema.optional(),
    settings: z.object({
      name: z.string().trim().min(1).max(80),
      transport: z.enum(['http', 'stdio']),
      target: z.string().trim().min(1).max(2048),
      args: z.array(z.string().max(4096)).max(128),
    }),
    credentials: z.record(z.string().min(1).max(200), z.string().max(16_384)).optional(),
  }),
  z.object({ action: z.literal('enable'), id: idSchema, enabled: z.boolean() }),
  z.object({ action: z.literal('retry'), id: idSchema }),
  z.object({ action: z.literal('remove'), id: idSchema }),
]);

const file = () => path.join(getAppPaths().appData, 'complements.json');
function read(): Stored[] {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8')) as Stored[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error('Could not read saved complements.');
  }
}

function write(services: Stored[]) {
  const target = file();
  const temporary = target + '.tmp';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify(services, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, target);
}

function validateSettings(settings: ComplementSettings) {
  if (settings.transport === 'stdio') {
    if ([settings.target, ...settings.args].some(value => value.includes('\0'))) {
      throw new Error('The command and arguments must be plain text.');
    }
    return;
  }
  let url: URL;
  try { url = new URL(settings.target); } catch { throw new Error('Enter a valid MCP endpoint URL.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.hash) {
    throw new Error('Use an HTTPS URL or local HTTP URL. Put credentials in the headers field.');
  }
  settings.target = url.href;
  settings.args = [];
}

function encryptCredentials(settings: ComplementSettings, values: Record<string, string>): string | undefined {
  const entries = Object.entries(values);
  if (!entries.length) return undefined;
  const name = settings.transport === 'http' ? /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/ : /^[A-Za-z_][A-Za-z0-9_]*$/;
  if (entries.some(([key, value]) => !name.test(key) || /[\0\r\n]/.test(value))) {
    throw new Error('Check the credential names and use single-line values.');
  }
  if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
    throw new Error('Unlock your system keyring before saving credentials.');
  }
  return safeStorage.encryptString(JSON.stringify(values)).toString('base64');
}

async function sync(client: AgenteClient, services: Stored[], retry?: string): Promise<Status> {
  const servers: Record<string, unknown> = {};
  for (const service of services) {
    if (!service.enabled) continue;
    let values: Record<string, string> = {};
    try {
      if (service.credentials) values = JSON.parse(safeStorage.decryptString(Buffer.from(service.credentials, 'base64')));
    } catch { continue; }
    servers[service.id] = {
      name: service.name,
      mcp: service.transport === 'http'
        ? { type: 'http', url: service.target, headers: values }
        : { type: 'stdio', command: [service.target], args: service.args, env: values },
    };
  }
  return client.request<Status>('complements.sync', { servers, retry });
}

async function list(services: Stored[], retry?: string): Promise<Complement[]> {
  let status: Status = {};
  if (services.some(service => service.enabled) || retry !== undefined) {
    try { status = await sync(await runtimeConnection(), services, retry); } catch { /* Saved services remain editable offline. */ }
  }
  return services.map(({ credentials, ...service }) => ({
    ...service, hasCredentials: !!credentials,
    ...(status[service.id] ?? { status: service.enabled ? 'unavailable' : 'disabled', tools: 0, toolNames: [] }),
  }));
}

// Serialize edits and status reads so an earlier request cannot re-enable a removed server.
let queued: Promise<unknown> = Promise.resolve();
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const next = queued.then(operation);
  queued = next.catch(() => {});
  return next;
}

export function homeComplements(client: AgenteClient): Promise<Map<string, string>> {
  return serialize(async () => {
    const services = read().filter(service => service.enabled);
    if (services.length) await sync(client, services);
    return new Map(services.map(service => [service.id, service.name]));
  });
}

function change(input: ComplementChange) {
  const update = changeSchema.safeParse(input);
  if (!update.success) throw new Error('Check the name, connection settings, and credentials.');
  const request = update.data;
  const services = read();
  const existing = services.find(service => service.id === request.id);
  if (request.id && !existing) throw new Error('This complement was removed.');
  if (request.action === 'retry') return list(services, request.id);
  if (request.action === 'save') {
    if (!existing && services.length >= 32) throw new Error('You can add up to 32 complements.');
    validateSettings(request.settings);
    const sameTarget = existing?.transport === request.settings.transport && existing.target === request.settings.target
      && JSON.stringify(existing.args) === JSON.stringify(request.settings.args);
    const credentials = request.credentials !== undefined
      ? encryptCredentials(request.settings, request.credentials)
      : sameTarget ? existing?.credentials : undefined;
    const updated = { ...request.settings, id: existing?.id ?? crypto.randomBytes(6).toString('hex'), enabled: existing?.enabled ?? true, credentials };
    if (existing) Object.assign(existing, updated);
    else services.push(updated);
  }
  if (request.action === 'enable' && existing) existing.enabled = request.enabled;
  const next = request.action === 'remove' ? services.filter(service => service !== existing) : services;
  write(next);
  return list(next, request.id);
}

export function registerComplementsHandlers(ipc: IpcMain) {
  ipc.handle('complements_list', () => serialize(() => list(read())));
  ipc.handle('complements_change', (_event, input: ComplementChange) => serialize(() => change(input)));
}

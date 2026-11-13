/**
 * Local model instances: the main one chat uses (llm-runner.ts) plus any
 * number of extra llama-server processes, each with its own model, port,
 * parallel request slots and key — like LM Studio's loaded models.
 *
 * Any instance can be shared on the local network: it is restarted bound to
 * 0.0.0.0 and keeps requiring its API key, so other devices need the key.
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { ManagedProcess, buildLlamaArgs } from './process-manager.ts';
import { resolveRuntimeBinary } from './runtime-resolver.ts';
import { inspectLlamaServer, supportsLlamaFlag } from './llama-runtime.ts';
import { getHardwareLimits } from './system-info.ts';
import { endInstanceSession, sessionKeyForPort, startInstanceSession } from './llama-session.ts';
import { getLlamaStatus, getMainLaunchConfig, startLlama } from './llm-runner.ts';

const FIRST_EXTRA_PORT = 11440;
const LOOPBACK = '127.0.0.1';
const EVERYWHERE = '0.0.0.0';

export type InstanceInfo = {
  id: string;
  main: boolean;
  model_id: string;
  model_path: string;
  state: string;
  error: string | null;
  port: number | null;
  shared: boolean;
  /** http://<lan-ip>:<port>/v1 when shared. */
  lan_url: string | null;
  local_url: string | null;
  parallel: number;
  context: number | null;
  started_at: number | null;
};

type Extra = {
  id: string;
  proc: ManagedProcess;
  port: number;
  host: string;
  config: Record<string, unknown>;
  state: string;
  error: string | null;
  startedAt: number;
};

const extras = new Map<string, Extra>();
let notify: (() => void) | null = null;

/** The window to tell when anything changes (`instances-changed`). */
export function setInstanceNotifier(win: () => BrowserWindow | null | undefined): void {
  notify = () => {
    const target = win();
    try { if (target && !target.isDestroyed()) target.webContents.send('instances-changed', listInstances()); } catch { /* closed */ }
  };
}

/**
 * The address other devices use to reach this computer: a private LAN
 * address (192.168/16, 10/8, 172.16/12) first; never a link-local 169.254
 * one, which an unplugged cable leaves behind.
 */
export function lanAddress(): string | null {
  const candidates: string[] = [];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal && !address.address.startsWith('169.254.')) candidates.push(address.address);
    }
  }
  const isPrivate = (ip: string) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return candidates.find(isPrivate) ?? candidates[0] ?? null;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, LOOPBACK, () => probe.close(() => resolve(true)));
  });
}

async function nextPort(): Promise<number> {
  const taken = new Set([Number(getLlamaStatus().port) || 11435, ...[...extras.values()].map((e) => e.port)]);
  for (let port = FIRST_EXTRA_PORT; port < FIRST_EXTRA_PORT + 200; port++) {
    if (!taken.has(port) && (await portFree(port))) return port;
  }
  throw new Error('No free port for another instance.');
}

function urls(host: string, port: number | null) {
  if (!port) return { local_url: null, lan_url: null };
  const lan = host === EVERYWHERE ? lanAddress() : null;
  return { local_url: `http://${LOOPBACK}:${port}/v1`, lan_url: lan ? `http://${lan}:${port}/v1` : null };
}

export function listInstances(): InstanceInfo[] {
  const list: InstanceInfo[] = [];
  const main = getLlamaStatus() as Record<string, unknown>;
  const mainConfig = getMainLaunchConfig();
  if (main.model_path && main.state && main.state !== 'idle') {
    const host = String(mainConfig?.host || LOOPBACK);
    const port = Number(main.port) || null;
    list.push({
      id: 'main',
      main: true,
      model_id: String(main.model_id || path.basename(String(main.model_path))),
      model_path: String(main.model_path),
      state: String(main.state),
      error: typeof main.message === 'string' ? main.message : null,
      port,
      shared: host === EVERYWHERE,
      ...urls(host, port),
      parallel: Number(mainConfig?.parallel) || 1,
      context: Number(main.n_ctx || mainConfig?.context_length) || null,
      started_at: null
    });
  }
  for (const extra of extras.values()) {
    list.push({
      id: extra.id,
      main: false,
      model_id: path.basename(String(extra.config.model_path)),
      model_path: String(extra.config.model_path),
      state: extra.state,
      error: extra.error,
      port: extra.port,
      shared: extra.host === EVERYWHERE,
      ...urls(extra.host, extra.port),
      parallel: Number(extra.config.parallel) || 1,
      context: Number(extra.config.context_length) || null,
      started_at: extra.startedAt
    });
  }
  return list;
}

async function launch(extra: Extra): Promise<void> {
  const runtimePath = resolveRuntimeBinary(extra.config.runtime_path as string);
  if (!runtimePath || !fs.existsSync(runtimePath)) throw new Error('llama-server binary not found. Install an engine first.');
  const capabilities = inspectLlamaServer(runtimePath);
  const apiKey = supportsLlamaFlag(capabilities, '--api-key') ? startInstanceSession(extra.port) : '';
  const args = buildLlamaArgs({ ...extra.config, host: extra.host, port: extra.port, api_key: apiKey }, runtimePath, await getHardwareLimits(), capabilities);
  extra.state = 'starting';
  extra.error = null;
  notify?.();
  try {
    await extra.proc.start({ binaryPath: runtimePath, args, healthPort: extra.port, statusFields: { port: extra.port } });
    extra.state = 'ready';
  } catch (err) {
    extra.state = 'error';
    extra.error = err instanceof Error ? err.message : String(err);
    endInstanceSession(extra.port);
    throw err;
  } finally {
    notify?.();
  }
}

export type StartInstanceOptions = {
  model_path: string;
  /** Requests served at the same time (llama.cpp slots). */
  parallel?: number;
  context_length?: number;
  share?: boolean;
  /** Everything the load dialog sets (context, GPU layers, KV cache…); wins over the quick options. */
  config?: Record<string, unknown>;
};

/** Start another model next to the main one. */
export async function startInstance(options: StartInstanceOptions): Promise<InstanceInfo[]> {
  if (!options.model_path || !fs.existsSync(options.model_path)) throw new Error(`Model file not found: ${options.model_path}`);
  const config = options.config
    ? { ...options.config, model_path: options.model_path, parallel: Math.max(1, Math.floor(Number(options.config.parallel) || 1)) }
    : quickConfig(options);
  return launchNew(config, !!options.share);
}

/**
 * The quick path (no dialog): only what was asked for. Context and GPU layers
 * stay unset unless given, so llama.cpp's --fit sizes them against real
 * memory; every slot can use the whole context (unified KV).
 */
function quickConfig(options: StartInstanceOptions): Record<string, unknown> {
  const config: Record<string, unknown> = {
    model_path: options.model_path,
    backend_mode: 'auto',
    parallel: Math.max(1, Math.min(16, Math.floor(Number(options.parallel) || 1)))
  };
  if (Number(options.context_length) > 0) config.context_length = Math.floor(Number(options.context_length));
  return config;
}

async function launchNew(config: Record<string, unknown>, share: boolean): Promise<InstanceInfo[]> {
  const port = await nextPort();
  const id = `inst-${port}`;
  const extra: Extra = {
    id, port, config,
    host: share ? EVERYWHERE : LOOPBACK,
    state: 'starting', error: null, startedAt: Date.now(),
    proc: new ManagedProcess({ initialStatus: { state: 'idle' }, onStatusChange: () => {} })
  };
  extras.set(id, extra);
  try {
    await launch(extra);
  } catch (err) {
    extras.delete(id);
    notify?.();
    throw err;
  }
  return listInstances();
}

export async function stopInstance(id: string, win?: BrowserWindow | null): Promise<InstanceInfo[]> {
  if (id === 'main') {
    const { stopLlama } = await import('./llm-runner.ts');
    await stopLlama(win);
  } else {
    const extra = extras.get(id);
    if (extra) {
      await extra.proc.stop({});
      endInstanceSession(extra.port);
      extras.delete(id);
    }
  }
  notify?.();
  return listInstances();
}

/** Share on (or take off) the local network: restarts the instance with the new binding. */
export async function setInstanceSharing(id: string, share: boolean, win?: BrowserWindow | null): Promise<InstanceInfo[]> {
  const host = share ? EVERYWHERE : LOOPBACK;
  if (id === 'main') {
    const config = getMainLaunchConfig();
    if (!config) throw new Error('The main model is not running.');
    await startLlama({ ...config, host }, win);
  } else {
    const extra = extras.get(id);
    if (!extra) throw new Error('That instance is no longer running.');
    await extra.proc.stop({});
    endInstanceSession(extra.port);
    extra.host = host;
    await launch(extra);
  }
  notify?.();
  return listInstances();
}

/** The API key clients need for an instance (shown so it can be copied). */
export function instanceKey(id: string): string {
  if (id === 'main') return sessionKeyForPort(Number(getLlamaStatus().port) || 11435);
  const extra = extras.get(id);
  return extra ? sessionKeyForPort(extra.port) : '';
}

export function stopAllInstances(): void {
  for (const extra of extras.values()) {
    extra.proc.kill();
    endInstanceSession(extra.port);
  }
  extras.clear();
}

// ── Agente runtime process ─────────────────────────────────────────────
// Desktop runs the Rust runtime as `agente serve` next to itself and talks
// to it over a local socket (agente-client.ts). The same socket is what a
// terminal attaches to, so a daemon already serving there is reused rather
// than started twice.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgenteClient } from './agente-client.ts';
import { AGENTE_PROTOCOL_VERSION } from '../shared/agente-protocol.gen.ts';

const START_TIMEOUT_MS = 15_000;

const EXE = process.platform === 'win32' ? 'agente.exe' : 'agente';

/**
 * The `agente` binary: `AGENTE_BIN`, then the copy bundled with a packaged
 * app. Development uses the debug build produced by dev:agente.
 */
export function resolveAgenteBinary(options: { resourcesPath?: string; repoRoot?: string } = {}): string | null {
  const candidates = [
    process.env.AGENTE_BIN,
    options.repoRoot ? path.join(options.repoRoot, 'target', 'debug', EXE) : undefined,
    options.repoRoot ? path.join(options.repoRoot, 'target', 'release', EXE) : undefined,
    options.resourcesPath ? path.join(options.resourcesPath, 'bin', EXE) : undefined
  ];
  return candidates.find((candidate): candidate is string => !!candidate && fs.existsSync(candidate)) ?? null;
}

/**
 * Same place `agente serve` uses by default, so terminals find it too: a
 * named pipe on Windows, a Unix socket elsewhere.
 */
export function defaultSocketPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return `\\\\.\\pipe\\agente-${env.USERNAME ?? 'user'}`;
  const folder = env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, 'agente') : path.join(env.HOME ?? os.homedir(), '.agente');
  return path.join(folder, 'agente.sock');
}

type DaemonOptions = {
  binary: string | null;
  socketPath?: string;
  /** Extra environment for the runtime (tests point its config elsewhere). */
  env?: NodeJS.ProcessEnv;
};

export const REQUIRED_CAPABILITIES = ['bots', 'routines', 'project', 'processes', 'sessions', 'turns', 'edits', 'desktop_v1'] as const;

type RuntimeHello = { protocol_version: number; version: string; capabilities?: string[] };

/**
 * Keeps one runtime connection alive: connects to a daemon already serving,
 * or starts one and waits for its socket. Concurrent callers share the same
 * attempt; a dropped connection is re-established on the next call.
 */
export class AgenteDaemon {
  private client: AgenteClient | null = null;
  private starting: Promise<AgenteClient> | null = null;
  private child: ChildProcess | null = null;
  private readonly socketPath: string;

  constructor(private readonly options: DaemonOptions) {
    this.socketPath = options.socketPath ?? defaultSocketPath();
  }

  get socket(): string {
    return this.socketPath;
  }

  connect(): Promise<AgenteClient> {
    if (this.client && !this.client.isClosed) return Promise.resolve(this.client);
    if (!this.starting) {
      this.starting = this.open().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  /** Stop the runtime this app started (one it only attached to keeps running). */
  stop(): void {
    this.client?.close();
    this.client = null;
    if (this.child && this.child.exitCode === null) this.child.kill('SIGINT');
    this.child = null;
  }

  private async open(): Promise<AgenteClient> {
    const existing = await AgenteClient.connect(this.socketPath).catch(() => null);
    const client = existing ?? (await this.spawnAndConnect());
    try {
      const hello = await client.request<RuntimeHello>('initialize', { client: 'agente-desktop' }, START_TIMEOUT_MS);
      const missing = REQUIRED_CAPABILITIES.filter((name) => !hello.capabilities?.includes(name));
      if (hello.protocol_version !== AGENTE_PROTOCOL_VERSION || missing.length) {
        throw new Error(
          `The Agente runtime on ${this.socketPath} is incompatible with this desktop ` +
          `(server ${hello.version}, protocol ${hello.protocol_version}; need protocol ${AGENTE_PROTOCOL_VERSION}` +
          `${missing.length ? `, missing ${missing.join(', ')}` : ''}). ` +
          'Restart agente serve with the current build, then restart the desktop. npm run dev builds the development runtime.'
        );
      }
      console.info(`[agente] connected socket=${this.socketPath} source=${existing ? 'existing daemon' : this.options.binary} version=${hello.version} protocol=${hello.protocol_version} capabilities=${hello.capabilities?.join(',')}`);
    } catch (error) {
      client.close();
      if (!existing) this.stop();
      throw error;
    }
    client.onClose(() => {
      if (this.client === client) this.client = null;
    });
    this.client = client;
    return client;
  }

  private async spawnAndConnect(): Promise<AgenteClient> {
    const binary = this.options.binary;
    if (!binary) throw new Error('The Agente runtime (agente) was not found. Build it with `cargo build --bin agente` or reinstall the app.');
    const output: string[] = [];
    const child = spawn(binary, ['serve', '--socket', this.socketPath], {
      env: { ...process.env, ...this.options.env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const keep = (chunk: Buffer) => {
      output.push(chunk.toString());
      if (output.length > 20) output.shift();
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    this.child = child;

    const exited = new Promise<never>((_, reject) => {
      child.once('exit', (code) => reject(new Error(`agente serve exited (${code ?? 'signal'}): ${output.join('').trim()}`)));
      child.once('error', reject);
    });
    const deadline = Date.now() + START_TIMEOUT_MS;
    const ready = (async () => {
      while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
        const client = await AgenteClient.connect(this.socketPath).catch(() => null);
        if (client) return client;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`agente serve did not open ${this.socketPath} within ${START_TIMEOUT_MS / 1000}s`);
    })();
    return Promise.race([ready, exited]);
  }
}

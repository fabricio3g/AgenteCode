/**
 * whisper.cpp in server mode: the model loads once and stays in (GPU) memory,
 * so each dictation costs only the transcription — ~0.3 s for a short clip on
 * an integrated Vulkan GPU, against ~1.8 s for a one-shot CLI run on the CPU.
 *
 * GPU without a GPU build: whisper.cpp loads its compute backends as plugins,
 * and the llama.cpp runtime the app already installs ships the same ggml
 * plugins (Vulkan, CUDA). `GGML_BACKEND_PATH` points whisper at that file.
 * ggml checks the plugin's API version before using it; if the pairing still
 * misbehaves, the server is restarted CPU-only and that choice is remembered
 * for the session.
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolveRuntimeBinary } from './runtime-resolver.ts';

const IDLE_SHUTDOWN_MS = 10 * 60_000;
const START_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 60_000;

const isWindows = process.platform === 'win32';
const SERVER_NAME = isWindows ? 'whisper-server.exe' : 'whisper-server';

/** GPU backend plugins, most capable first. */
const GPU_PLUGINS = isWindows
  ? ['ggml-cuda.dll', 'ggml-vulkan.dll', 'ggml-hip.dll']
  : process.platform === 'darwin'
    ? [] // Metal is built into macOS builds.
    : ['libggml-cuda.so', 'libggml-vulkan.so', 'libggml-hip.so'];

type Server = {
  child: ChildProcess;
  port: number;
  key: string;
  gpu: string | null;
};

let server: Server | null = null;
let starting: Promise<Server> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
/** Set once a borrowed GPU plugin failed: stay on the CPU for this session. */
let gpuDisabled = false;

/** whisper-server next to the resolved whisper-cli, if the runtime has one. */
export function findWhisperServer(cliPath: string | null): string | null {
  if (!cliPath) return null;
  const candidate = path.join(path.dirname(cliPath), SERVER_NAME);
  return fs.existsSync(candidate) ? candidate : null;
}

function hasOwnGpuBackend(serverDir: string): boolean {
  return GPU_PLUGINS.some((name) => fs.existsSync(path.join(serverDir, name)));
}

/** A GPU plugin from the installed llama.cpp runtime, for a CPU-only whisper build. */
function borrowedGpuPlugin(serverDir: string): string | null {
  if (gpuDisabled || hasOwnGpuBackend(serverDir)) return null;
  const llamaServer = resolveRuntimeBinary();
  if (!llamaServer) return null;
  const dir = path.dirname(llamaServer);
  for (const name of GPU_PLUGINS) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('No free port'))));
    });
  });
}

async function waitReady(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`whisper-server exited with code ${child.exitCode}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
      if (res.ok || res.status === 404) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('whisper-server did not start in time');
}

function stopServer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const current = server;
  server = null;
  if (current && current.child.exitCode === null) current.child.kill();
}

function touch(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(stopServer, IDLE_SHUTDOWN_MS);
  idleTimer.unref?.();
}

async function launch(serverPath: string, modelPath: string, gpuPlugin: string | null): Promise<Server> {
  const port = await freePort();
  const threads = Math.max(1, Math.min(os.cpus().length, 4));
  const dir = path.dirname(serverPath);
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Shared libraries sit beside the binary in the release archives.
  if (!isWindows) env.LD_LIBRARY_PATH = [dir, env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter);
  if (gpuPlugin) env.GGML_BACKEND_PATH = gpuPlugin;
  else delete env.GGML_BACKEND_PATH;

  const child = spawn(serverPath, ['-m', modelPath, '--host', '127.0.0.1', '--port', String(port), '-t', String(threads)], {
    cwd: dir,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true
  });
  let log = '';
  child.stderr?.on('data', (chunk: Buffer) => { log = (log + chunk.toString()).slice(-4000); });
  try {
    await waitReady(port, child);
  } catch (err) {
    if (child.exitCode === null) child.kill();
    const tail = log.trim().split('\n').slice(-3).join(' ');
    throw new Error(`${err instanceof Error ? err.message : String(err)}${tail ? `: ${tail}` : ''}`);
  }
  child.on('exit', () => { if (server?.child === child) server = null; });
  return { child, port, key: `${serverPath}|${modelPath}|${gpuPlugin || ''}`, gpu: gpuPlugin ? path.basename(gpuPlugin) : (hasOwnGpuBackend(dir) ? 'built-in' : null) };
}

async function ensureServer(serverPath: string, modelPath: string): Promise<Server> {
  const gpuPlugin = borrowedGpuPlugin(path.dirname(serverPath));
  const key = `${serverPath}|${modelPath}|${gpuPlugin || ''}`;
  if (server && server.key === key && server.child.exitCode === null) return server;
  if (starting) return starting;
  stopServer();
  starting = (async () => {
    try {
      return await launch(serverPath, modelPath, gpuPlugin);
    } catch (err) {
      if (!gpuPlugin) throw err;
      console.warn('[whisper-server] GPU start failed, using the CPU:', err instanceof Error ? err.message : err);
      gpuDisabled = true;
      return await launch(serverPath, modelPath, null);
    }
  })();
  try {
    server = await starting;
    return server;
  } finally {
    starting = null;
  }
}

async function request(current: Server, wav: Buffer, language: string): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav');
  form.append('response_format', 'json');
  form.append('temperature', '0');
  form.append('language', language || 'auto');
  const res = await fetch(`http://127.0.0.1:${current.port}/inference`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`whisper-server HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json() as { text?: string; error?: string };
  if (data.error) throw new Error(data.error);
  return String(data.text || '').replace(/\s+/g, ' ').trim();
}

/** Transcribe 16 kHz mono WAV with a warm server. */
export async function transcribeWithServer(serverPath: string, modelPath: string, wav: Buffer, language: string): Promise<{ text: string; gpu: string | null }> {
  let current = await ensureServer(serverPath, modelPath);
  try {
    const text = await request(current, wav, language);
    touch();
    return { text, gpu: current.gpu };
  } catch (err) {
    // A borrowed GPU plugin that starts but fails mid-request: retry on the CPU once.
    if (!current.key.endsWith('|') && !gpuDisabled) {
      console.warn('[whisper-server] GPU request failed, retrying on the CPU:', err instanceof Error ? err.message : err);
      gpuDisabled = true;
      stopServer();
      current = await ensureServer(serverPath, modelPath);
      const text = await request(current, wav, language);
      touch();
      return { text, gpu: current.gpu };
    }
    stopServer();
    throw err;
  }
}

/** What GPU a whisper-server in `serverDir` would use: its own build, a borrowed plugin, or none. */
export function whisperGpuInfo(serverDir: string): { source: 'built-in' | 'borrowed' | 'none'; backend: string | null } {
  const own = GPU_PLUGINS.find((name) => fs.existsSync(path.join(serverDir, name)));
  if (own) return { source: 'built-in', backend: own };
  const borrowed = borrowedGpuPlugin(serverDir);
  return borrowed ? { source: 'borrowed', backend: path.basename(borrowed) } : { source: 'none', backend: null };
}

export function whisperServerStatus(): { running: boolean; gpu: string | null } {
  return { running: !!server && server.child.exitCode === null, gpu: server?.gpu ?? null };
}

export function stopWhisperServer(): void {
  stopServer();
}

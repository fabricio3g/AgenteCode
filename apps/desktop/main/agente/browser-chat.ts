// ── Browser chat: Desktop's end of the extension's side panel ──────────
// The extension talks to the bridge hub on 127.0.0.1 (crates/agente-bridge);
// Desktop joins that hub as the `app` and answers the panel's chat with Home
// turns run by the renderer (renderer/src/lib/services/browser-chat.ts).
// This file only relays: hub frame in → renderer request; renderer reply →
// hub frame out.
//
// When no hub is listening (no Agente session open), Desktop starts one with
// `agente bridge serve` so the panel works with only the app running.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { app, type BrowserWindow, type IpcMain } from 'electron';
import { desktopAgenteBinary } from './rust-engine.ts';
import type { ChatEvent, ChatRequest } from '../../shared/browser/chat-protocol.ts';

type Frame =
  | { type: 'welcome' }
  | { type: 'chat'; id: string; body: ChatRequest }
  | { type: 'ping'; id?: number }
  | { type: 'error'; message: string }
  | { type: string };

interface Pairing {
  port: number;
  token: string;
}

const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 15_000;
/** Don't start another hub while a recent one may still be binding. */
const HUB_SPAWN_GAP_MS = 15_000;

let socket: WebSocket | null = null;
let hub: ChildProcess | null = null;
let hubSpawnedAt = 0;
let retryMs = RETRY_MIN_MS;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let rendererReady = false;
let stopped = false;

/** Same home the bridge uses (`AGENTE_BRIDGE_DIR` in tests). */
function pairingPath(): string {
  const dir = process.env.AGENTE_BRIDGE_DIR || path.join(os.homedir(), '.agente');
  return path.join(dir, 'bridge-token.json');
}

function readPairing(): Pairing | null {
  try {
    const value = JSON.parse(fs.readFileSync(pairingPath(), 'utf8'));
    return typeof value?.port === 'number' && typeof value?.token === 'string' ? value : null;
  } catch {
    return null;
  }
}

function send(frame: Record<string, unknown>) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
}

function answer(id: string, body: ChatEvent) {
  send({ type: 'chat_event', id, body });
}

/** One `agente bridge serve`, only when nobody holds the port. */
function startHub() {
  if (hub || Date.now() - hubSpawnedAt < HUB_SPAWN_GAP_MS) return;
  const binary = desktopAgenteBinary();
  if (!binary) return;
  hubSpawnedAt = Date.now();
  const child = spawn(binary, ['bridge', 'serve'], { stdio: 'ignore', windowsHide: true });
  hub = child;
  child.on('error', (error) => console.warn('[browser-chat] could not start the bridge', error));
  // Exits at once when a session's bridge already holds the port: fine.
  child.on('exit', () => {
    if (hub === child) hub = null;
  });
}

function scheduleRetry(getWindow: () => BrowserWindow | null) {
  if (stopped || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect(getWindow);
  }, retryMs);
  retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
}

function connect(getWindow: () => BrowserWindow | null) {
  if (stopped) return;
  const pairing = readPairing();
  if (!pairing) {
    // The bridge writes the pairing file on first start.
    startHub();
    scheduleRetry(getWindow);
    return;
  }
  let opened = false;
  const ws = new WebSocket(`ws://127.0.0.1:${pairing.port}/`);
  socket = ws;
  ws.onopen = () => {
    opened = true;
    retryMs = RETRY_MIN_MS;
    ws.send(JSON.stringify({
      type: 'hello',
      token: pairing.token,
      role: 'app',
      client: { name: 'agente-desktop', version: app.getVersion() }
    }));
  };
  ws.onmessage = (event) => onFrame(String(event.data), getWindow);
  ws.onerror = () => {};
  ws.onclose = () => {
    if (socket === ws) socket = null;
    if (!opened) startHub();
    scheduleRetry(getWindow);
  };
}

function onFrame(text: string, getWindow: () => BrowserWindow | null) {
  let frame: Frame;
  try {
    frame = JSON.parse(text);
  } catch {
    return;
  }
  if (frame.type === 'ping') {
    send({ type: 'pong', id: (frame as { id?: number }).id ?? 0 });
  } else if (frame.type === 'error') {
    console.warn('[browser-chat] the bridge refused Desktop:', (frame as { message: string }).message);
  } else if (frame.type === 'chat') {
    const { id, body } = frame as { id: string; body: ChatRequest };
    deliver(id, body, getWindow());
  }
}

function deliver(id: string, body: ChatRequest, win: BrowserWindow | null) {
  if (!win || win.isDestroyed() || !rendererReady) {
    answer(id, { type: 'error', message: 'Agente Desktop is still starting. Try again in a moment.' });
    return;
  }
  if (body?.type === 'reveal') {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  win.webContents.send('browser_chat_request', { id, body });
}

export function registerBrowserChat(ipcMain: IpcMain, getWindow: () => BrowserWindow | null) {
  ipcMain.handle('browser_chat_ready', () => {
    rendererReady = true;
  });
  ipcMain.handle('browser_chat_reply', (_event, args: { id?: unknown; body?: unknown }) => {
    if (typeof args?.id !== 'string' || !args.body || typeof args.body !== 'object') return;
    answer(args.id, args.body as ChatEvent);
  });
  connect(getWindow);
}

export function stopBrowserChat() {
  stopped = true;
  if (retryTimer) clearTimeout(retryTimer);
  socket?.close();
  hub?.kill();
  hub = null;
}

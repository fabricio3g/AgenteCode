// ── Background: one socket to the Agente bridge ───────────────────────
// Pairs with the local bridge hub (crates/agente-bridge) using the code from
// `agente bridge status`, answers its browser actions against the user's
// real tabs, and relays the side panel's chat to Agente Desktop.
//
// Chrome runs this as a service worker, Firefox as an event page; neither
// may be kept alive forever, so the socket reconnects on every wake (an
// alarm, a panel opening) and pings while open.

import { ext, isFirefox } from './webext';
import { pageContext, runAction } from './actions';
import type { PanelIn, PanelOut, BridgeStatus } from './panel/messages';
import type { ChatEvent } from '../../shared/browser/chat-protocol';

const VERSION: string = ext.runtime.getManifest().version;
const PING_MS = 20_000;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 15_000;
const STORAGE_KEY = 'pairing';

let socket: WebSocket | null = null;
let status: BridgeStatus = { state: 'unpaired', app: false };
let retryMs = RETRY_MIN_MS;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let pingId = 0;
const panels = new Set<{ postMessage(message: PanelOut): void }>();

function broadcast(message: PanelOut) {
  for (const panel of panels) {
    try {
      panel.postMessage(message);
    } catch {
      panels.delete(panel);
    }
  }
}

function setStatus(next: Partial<BridgeStatus>) {
  status = { ...status, ...next };
  broadcast({ kind: 'status', status });
}

function send(frame: Record<string, unknown>): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(frame));
  return true;
}

function parseCode(code: string): { port: number; token: string } | null {
  const match = /^\s*(\d{1,5})\.([A-Za-z0-9]{16,})\s*$/.exec(code || '');
  if (!match) return null;
  const port = Number(match[1]);
  return port > 0 && port < 65536 ? { port, token: match[2] } : null;
}

async function storedCode(): Promise<string> {
  const stored = await ext.storage.local.get(STORAGE_KEY);
  return typeof stored?.[STORAGE_KEY] === 'string' ? stored[STORAGE_KEY] : '';
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void connect();
  }, retryMs);
  retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
}

async function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  // A refused code stays refused until the person pairs again.
  if (status.state === 'refused') return;
  const pairing = parseCode(await storedCode());
  if (!pairing) {
    setStatus({ state: 'unpaired', app: false, error: undefined });
    return;
  }
  setStatus({ state: 'connecting' });
  const ws = new WebSocket(`ws://127.0.0.1:${pairing.port}/`);
  socket = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: 'hello',
      token: pairing.token,
      role: 'extension',
      client: { name: 'agente-extension', version: VERSION, browser: isFirefox ? 'firefox' : 'chrome', capabilities: [] }
    }));
  };
  ws.onmessage = (event) => void onFrame(String(event.data));
  ws.onerror = () => {};
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    if (status.state !== 'refused') setStatus({ state: 'offline', app: false });
    if (status.state !== 'refused') scheduleRetry();
  };
}

async function onFrame(text: string) {
  let frame: { type: string; [key: string]: unknown };
  try {
    frame = JSON.parse(text);
  } catch {
    return;
  }
  switch (frame.type) {
    case 'welcome':
      retryMs = RETRY_MIN_MS;
      setStatus({ state: 'connected', app: !!frame.app, error: undefined });
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => send({ type: 'ping', id: ++pingId }), PING_MS);
      break;
    case 'status':
      setStatus({ app: !!frame.app });
      break;
    case 'action': {
      const id = String(frame.id);
      const result = await runAction(String(frame.action), (frame.args as Record<string, unknown>) ?? {});
      send({ type: 'result', id, ...result });
      break;
    }
    case 'chat_event':
      broadcast({ kind: 'chat', id: String(frame.id), body: frame.body as ChatEvent });
      break;
    case 'error':
      // Only a refused pairing closes for good; anything else is a notice.
      if (/token|paired/i.test(String(frame.message))) {
        setStatus({ state: 'refused', app: false, error: String(frame.message) });
      } else {
        setStatus({ error: String(frame.message) });
      }
      break;
  }
}

async function onPanelMessage(port: { postMessage(message: PanelOut): void }, message: PanelIn) {
  switch (message.kind) {
    case 'hello':
      port.postMessage({ kind: 'status', status });
      void connect();
      break;
    case 'pair': {
      if (!parseCode(message.code)) {
        port.postMessage({ kind: 'status', status: { ...status, error: 'That is not a pairing code. Run `agente bridge status` and copy the code it prints.' } });
        return;
      }
      await ext.storage.local.set({ [STORAGE_KEY]: message.code.trim() });
      socket?.close();
      socket = null;
      retryMs = RETRY_MIN_MS;
      status = { ...status, state: 'connecting', error: undefined };
      void connect();
      break;
    }
    case 'unpair':
      await ext.storage.local.remove(STORAGE_KEY);
      socket?.close();
      socket = null;
      setStatus({ state: 'unpaired', app: false, error: undefined });
      break;
    case 'chat':
      if (!send({ type: 'chat', id: message.id, body: message.body })) {
        port.postMessage({ kind: 'chat', id: message.id, body: { type: 'error', message: 'Not connected to Agente. Check the pairing, and that Agente Desktop is open.' } });
        void connect();
      }
      break;
    case 'page':
      port.postMessage({ kind: 'page', page: await pageContext() });
      break;
  }
}

ext.runtime.onConnect.addListener((port: { name: string; postMessage(message: PanelOut): void; onMessage: { addListener(fn: (message: PanelIn) => void): void }; onDisconnect: { addListener(fn: () => void): void } }) => {
  if (port.name !== 'panel') return;
  panels.add(port);
  port.onMessage.addListener((message) => void onPanelMessage(port, message));
  port.onDisconnect.addListener(() => panels.delete(port));
});

// The toolbar button opens the chat panel.
if (isFirefox) {
  ext.action.onClicked.addListener(() => ext.sidebarAction.toggle());
} else {
  ext.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
}

// Wake up now and then to reconnect after the worker was put to sleep.
ext.alarms.create('agente-reconnect', { periodInMinutes: 0.5 });
ext.alarms.onAlarm.addListener((alarm: { name: string }) => {
  if (alarm.name === 'agente-reconnect') void connect();
});
ext.runtime.onStartup.addListener(() => void connect());
ext.runtime.onInstalled.addListener(() => void connect());
void connect();

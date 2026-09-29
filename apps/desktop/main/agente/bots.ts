// ── Agente Bot in Desktop ───────────────────────────────────────────────
// The Bots screen talks to the bots that live in the Rust runtime
// (`agente serve`): the roster, each bot's files and routines, and its one
// chat. A bot's chat renders like a Code chat: its runtime events, live or
// replayed from the saved conversation (bot-history.ts), go through the same
// RustTurnTranslator and reach the renderer on `bot_event` as the Code UI's
// events, with `bot:<handle>` as their chat id. That covers turns started
// here and the ones the runtime starts itself (routines, handoffs).

import type { BrowserWindow, IpcMain } from 'electron';
import { onRuntimeEvent, providerConfig, runtimeConnection, useProvider } from './rust-engine.ts';
import { RustTurnTranslator } from './rust-events.ts';
import { historyTurns } from './bot-history.ts';
import type { RuntimeEventEnvelope, SessionSnapshot } from '../../shared/agente-protocol.gen.ts';

type ModelChoice = { provider?: string; model?: string; thinkingLevel?: string };
type ModelPin = { provider: string; model: string };
type BotSummary = { handle: string; session_id: string | null; model?: ModelPin };

/** How often an unknown session may trigger a roster refresh. */
const REFRESH_MS = 2_000;

const sessionBots = new Map<string, string>();
const translators = new Map<string, RustTurnTranslator>();
let lastRefresh = 0;
let unsubscribe: (() => void) | null = null;

function botChatId(handle: string): string {
  return `bot:${handle}`;
}

async function request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const client = await runtimeConnection();
  return client.request<T>(method, params);
}

function remember(bots: BotSummary[]): void {
  for (const bot of bots) if (bot.session_id) sessionBots.set(bot.session_id, bot.handle);
}

async function listBots(): Promise<BotSummary[]> {
  const bots = await request<BotSummary[]>('bots.list');
  lastRefresh = Date.now();
  remember(bots);
  void registerPinnedProviders(bots).catch(() => {});
  return bots;
}

/**
 * Bots (and routines) pinned to a model reach its provider through the
 * runtime, which has no keys of its own: give it Desktop's endpoint and key
 * for every provider a pin names, with all the models pinned there. Pins
 * made by routines use the `desktop-<name>` ids the chat registers.
 */
async function registerPinnedProviders(bots: BotSummary[]): Promise<void> {
  const byProvider = groupPins(await pinsOf(bots));
  if (!byProvider.size) return;
  const provider: Record<string, unknown> = {};
  for (const [id, models] of byProvider) provider[id] = providerConfig(id.replace(/^desktop-/, ''), [...models]);
  await request('runtime.configure', { provider });
}

/** Every model pin: the bots' own and their routines'. */
async function pinsOf(bots: BotSummary[]): Promise<ModelPin[]> {
  const pins = bots.map((bot) => bot.model);
  for (const bot of bots) {
    const routines = await request<Array<{ model?: ModelPin }>>('routines.list', { handle: bot.handle }).catch(() => []);
    pins.push(...routines.map((routine) => routine.model));
  }
  return pins.filter((pin): pin is ModelPin => !!pin);
}

function groupPins(pins: ModelPin[]): Map<string, Set<string>> {
  const byProvider = new Map<string, Set<string>>();
  for (const pin of pins) byProvider.set(pin.provider, (byProvider.get(pin.provider) ?? new Set()).add(pin.model));
  return byProvider;
}

/** Save a bot, then make sure the runtime can reach the model it is pinned to. */
async function saveBot(method: 'bots.create' | 'bots.update', args: Record<string, unknown>): Promise<unknown> {
  const saved = await request(method, args);
  await listBots().catch(() => []);
  return saved;
}

/** The bot a session belongs to, looking at the roster again if it's new. */
async function botFor(sessionId: string): Promise<string | undefined> {
  if (!sessionBots.has(sessionId) && Date.now() - lastRefresh > REFRESH_MS) await listBots().catch(() => []);
  return sessionBots.get(sessionId);
}

function translatorFor(handle: string): RustTurnTranslator {
  let translator = translators.get(handle);
  if (!translator) {
    translator = new RustTurnTranslator(botChatId(handle), () => 0);
    translators.set(handle, translator);
  }
  return translator;
}

/** The runtime ids for the model the app is using, registered with the runtime. */
async function modelFor(choice: ModelChoice): Promise<{ provider?: string; model?: string; thinking_level?: string }> {
  if (!choice.provider || !choice.model) return {};
  const client = await runtimeConnection();
  const provider = await useProvider(client, choice.provider, choice.model);
  return { provider: provider.id, model: provider.model, ...(choice.thinkingLevel ? { thinking_level: choice.thinkingLevel } : {}) };
}

/** Plain calls: the renderer's arguments go to the runtime method as they are. */
const PASSTHROUGH: Record<string, string> = {
  bots_get: 'bots.get',
  bots_delete: 'bots.delete',
  bots_write_doc: 'bots.write_doc',
  bots_compact: 'bots.compact',
  bots_cancel: 'turn.cancel',
  bots_telegram: 'bots.telegram',
  bots_telegram_connect: 'bots.telegram_connect',
  bots_telegram_disconnect: 'bots.telegram_disconnect',
  bots_telegram_pair: 'bots.telegram_pair',
  bots_telegram_unpair: 'bots.telegram_unpair',
  routines_list: 'routines.list',
  routines_delete: 'routines.delete',
  routines_run_now: 'routines.run_now'
};

async function history(handle: string) {
  const bot = await request<BotSummary>('bots.get', { handle });
  if (!bot.session_id) return [];
  sessionBots.set(bot.session_id, handle);
  const { snapshot } = await request<{ snapshot: SessionSnapshot }>('session.get', { session_id: bot.session_id });
  return historyTurns(snapshot.conversation, botChatId(handle));
}

async function forward(envelope: RuntimeEventEnvelope, getMainWindow: () => BrowserWindow | null): Promise<void> {
  const handle = await botFor(envelope.session_id);
  const win = getMainWindow();
  if (!handle || !win || win.isDestroyed()) return;
  for (const event of translatorFor(handle).translate(envelope)) win.webContents.send('bot_event', { handle, event });
}

export function registerBotHandlers(ipcMain: IpcMain, getMainWindow: () => BrowserWindow | null): void {
  for (const [channel, method] of Object.entries(PASSTHROUGH)) {
    ipcMain.handle(channel, (_e, args: Record<string, unknown> = {}) => request(method, args));
  }
  ipcMain.handle('bots_list', () => listBots());
  ipcMain.handle('bots_create', (_e, args: Record<string, unknown> = {}) => saveBot('bots.create', args));
  ipcMain.handle('bots_update', (_e, args: Record<string, unknown> = {}) => saveBot('bots.update', args));
  ipcMain.handle('bots_history', (_e, args: { handle: string }) => history(args.handle));

  ipcMain.handle('bots_chat', async (_e, args: { handle: string; text: string } & ModelChoice) => {
    const started = await request<{ turn_id: string; session_id: string }>('bots.chat', {
      handle: args.handle,
      text: args.text,
      ...(await modelFor(args))
    });
    sessionBots.set(started.session_id, args.handle);
    return started;
  });

  ipcMain.handle('routines_save', async (_e, args: { handle: string; routine: Record<string, unknown> } & ModelChoice) => {
    const model = await modelFor(args);
    // A routine keeps the model it was made with, for runs while no one is here.
    const pin = model.provider && model.model ? { model: { provider: model.provider, model: model.model } } : {};
    return request('routines.save', { handle: args.handle, routine: { ...pin, ...args.routine } });
  });

  ipcMain.handle('bots_respond_approval', (_e, args: { requestId: string; decision: 'allow' | 'deny' }) =>
    request('approval.respond', { request_id: args.requestId, decision: args.decision === 'allow' ? 'approve_once' : 'deny' })
  );

  unsubscribe?.();
  unsubscribe = onRuntimeEvent((envelope) => {
    void forward(envelope, getMainWindow).catch(() => {});
  });
}

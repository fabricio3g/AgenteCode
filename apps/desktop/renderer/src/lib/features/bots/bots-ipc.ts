// The Bots screen's calls into the main process (main/agente/bots.ts),
// which forwards them to the bots living in the Rust runtime.

import { invoke, listen } from '$lib/services/bridge';
import type { CodeAgentEvent } from '$shared/agente-protocol';

export type BotTint = 'green' | 'blue' | 'yellow' | 'red';

export interface BotConfig {
  title: string;
  role: string;
  /** `seed` draws the face; a bot without one is drawn from its handle. */
  avatar: { initials?: string; image?: string; tint: string; seed?: number };
  /** A pinned model; `thinking` is its level (auto when absent). */
  model?: { provider: string; model: string; thinking?: string };
  toolsets: string[];
  skills: string[];
  daily_budget?: number;
  /** `[sandbox]` in bot.toml: what its programs may do beyond its workspace. */
  sandbox?: { network?: boolean; read?: string[]; write?: string[]; file_mb?: number; cpu_secs?: number };
}

export interface Bot extends BotConfig {
  handle: string;
  builtin: boolean;
  session_id: string | null;
  working: boolean;
  /** What the bot has spent today, in US dollars. */
  spent_today?: number;
}

export interface BotDetail extends Bot {
  soul: string;
  user: string;
  memory: string;
}

export type BotDoc = 'soul' | 'user' | 'memory';

export type Schedule =
  | { every: 'hour'; minute: number }
  | { every: 'day'; at: string }
  | { every: 'weekdays'; at: string }
  | { every: 'week'; day: string; at: string }
  | { every: 'cron'; expr: string };

export interface Routine {
  id: string;
  title: string;
  prompt: string;
  schedule: Schedule;
  paused: boolean;
  created_at: string;
  last_run: { at: string; status: string } | null;
  next_run: string | null;
}

export type NewRoutine = Pick<Routine, 'title' | 'prompt' | 'schedule' | 'paused'> & { id?: string };

/** Who started a turn in a bot's chat. */
export type BotTurnSource = { kind: 'user' } | { kind: 'routine'; title: string } | { kind: 'handoff'; from: string };

interface BotHistoryTurn {
  prompt: string;
  source: BotTurnSource;
  events: CodeAgentEvent[];
}

export type ChannelTrust = 'owner' | 'trusted';

export interface PairedChat {
  chat_id: number;
  name: string;
  trust: ChannelTrust;
  paired_at: string;
}

export interface PairingCode {
  code: string;
  trust: ChannelTrust;
  expires_at: string;
}

/** A bot's Telegram channel (the token itself never comes back). */
export interface TelegramStatus {
  connected: boolean;
  username: string | null;
  error: string | null;
  paired: PairedChat[];
  pairing: PairingCode | null;
}

/** A group of tools a bot can be given (from the core's list). */
export interface Toolset {
  id: string;
  tools: string[];
}

/** Whether the machine running the bots boxes their programs. */
export interface SandboxStatus {
  backend: 'landlock' | 'seatbelt' | 'none';
  available: boolean;
}

/** The model the app is using (bots without a pinned model use it). */
export type ModelChoice = { provider?: string; model?: string };

export const botsIpc = {
  list: () => invoke<Bot[]>('bots_list', {}),
  get: (handle: string) => invoke<BotDetail>('bots_get', { handle }),
  toolsets: () => invoke<Toolset[]>('bots_toolsets', {}),
  sandbox: () => invoke<SandboxStatus>('bots_sandbox', {}),
  create: (bot: Partial<BotConfig> & { title: string; soul?: string; handle?: string }) => invoke<Bot>('bots_create', bot),
  update: (handle: string, config: BotConfig) => invoke<Bot>('bots_update', { handle, config }),
  remove: (handle: string) => invoke<{ deleted: boolean }>('bots_delete', { handle }),
  writeDoc: (handle: string, doc: BotDoc, text: string) => invoke<{ ok: boolean }>('bots_write_doc', { handle, doc, text }),
  compact: (handle: string) => invoke<{ messages: number }>('bots_compact', { handle }),
  history: (handle: string) => invoke<BotHistoryTurn[]>('bots_history', { handle }),
  chat: (handle: string, text: string, model: ModelChoice) => invoke<{ turn_id: string; session_id: string }>('bots_chat', { handle, text, ...model }),
  cancel: (turnId: string) => invoke<{ ok: boolean }>('bots_cancel', { turn_id: turnId }),
  respondApproval: (requestId: string, decision: 'allow' | 'deny') => invoke<{ ok: boolean }>('bots_respond_approval', { requestId, decision }),
  routines: (handle: string) => invoke<Routine[]>('routines_list', { handle }),
  saveRoutine: (handle: string, routine: NewRoutine, model: ModelChoice) => invoke<Routine>('routines_save', { handle, routine, ...model }),
  deleteRoutine: (handle: string, id: string) => invoke<{ deleted: boolean }>('routines_delete', { handle, id }),
  runRoutine: (handle: string, id: string) => invoke<{ turn_id: string }>('routines_run_now', { handle, id }),
  telegram: (handle: string) => invoke<TelegramStatus>('bots_telegram', { handle }),
  telegramConnect: (handle: string, token: string) => invoke<TelegramStatus>('bots_telegram_connect', { handle, token }),
  telegramDisconnect: (handle: string) => invoke<TelegramStatus>('bots_telegram_disconnect', { handle }),
  telegramPair: (handle: string, trust: ChannelTrust) => invoke<PairingCode>('bots_telegram_pair', { handle, trust }),
  telegramUnpair: (handle: string, chatId: number) => invoke<TelegramStatus>('bots_telegram_unpair', { handle, chat_id: chatId })
};

/** Live events of every bot's chat, as the Code UI's events. */
export function onBotEvent(handler: (handle: string, event: CodeAgentEvent) => void): Promise<() => void> {
  return listen<{ handle: string; event: CodeAgentEvent }>('bot_event', (payload) => handler(payload.handle, payload.event));
}

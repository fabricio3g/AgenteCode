// The Bots screen's state: the roster, the open bot's chat and routines.
//
// A bot's chat is a list of turns, each folded from the Code UI's events
// with the same run logic the Code section uses (code-run.ts): history
// arrives replayed as events, and live turns stream in on `bot_event`,
// including ones the runtime started (routines, handoffs from teammates).

import { applyCodeAgentEvent, createCodeRunState, type CodeRunState } from '$lib/features/code/code-run';
import { approvalsStore } from '$lib/stores/approvals.svelte';
import { currentProviderModel as currentModel } from '$lib/services/current-model';
import type { CodeAgentEvent } from '$shared/agente-protocol';
import {
  botsIpc,
  onBotEvent,
  type Bot,
  type BotConfig,
  type BotDetail,
  type BotDoc,
  type BotTurnSource,
  type NewRoutine,
  type Routine
} from './bots-ipc';

export interface BotTurnView {
  key: string;
  /** Null while a turn someone else started (a routine, a teammate) is running. */
  prompt: string | null;
  source: BotTurnSource;
  run: CodeRunState;
}

let turnSeq = 0;

function foldTurn(prompt: string | null, source: BotTurnSource, events: CodeAgentEvent[]): BotTurnView {
  const run = createCodeRunState();
  for (const event of events) applyCodeAgentEvent(run, event);
  turnSeq += 1;
  return { key: `turn-${turnSeq}`, prompt, source, run };
}

function chatIdOf(handle: string): string {
  return `bot:${handle}`;
}

class BotsStore {
  bots = $state<Bot[]>([]);
  loaded = $state(false);
  error = $state<string | null>(null);
  selected = $state<string | null>(null);
  detail = $state<BotDetail | null>(null);
  turns = $state<Record<string, BotTurnView[]>>({});
  routines = $state<Record<string, Routine[]>>({});
  /** Turns started from this window, by bot, so Stop can cancel them. */
  #turnIds = new Map<string, string>();
  #listening = false;

  get current(): Bot | null {
    return this.bots.find((bot) => bot.handle === this.selected) ?? null;
  }

  get working(): Bot[] {
    return this.bots.filter((bot) => bot.working);
  }

  turnsFor(handle: string | null): BotTurnView[] {
    return handle ? (this.turns[handle] ?? []) : [];
  }

  async load(): Promise<void> {
    this.#listen();
    try {
      this.bots = await botsIpc.list();
      this.error = null;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
    this.loaded = true;
    if (!this.selected && this.bots.length) await this.select(this.bots[0].handle);
  }

  async select(handle: string): Promise<void> {
    this.selected = handle;
    const [detail, history, routines] = await Promise.all([
      botsIpc.get(handle),
      botsIpc.history(handle),
      botsIpc.routines(handle).catch(() => [] as Routine[])
    ]);
    if (this.selected !== handle) return;
    this.detail = detail;
    this.turns = { ...this.turns, [handle]: history.map((turn) => foldTurn(turn.prompt, turn.source, turn.events)) };
    this.routines = { ...this.routines, [handle]: routines };
  }

  async send(text: string): Promise<void> {
    const handle = this.selected;
    const message = text.trim();
    if (!handle || !message) return;
    const turn = foldTurn(message, { kind: 'user' }, []);
    this.turns = { ...this.turns, [handle]: [...this.turnsFor(handle), turn] };
    this.#setWorking(handle, true);
    try {
      const started = await botsIpc.chat(handle, message, await currentModel());
      this.#turnIds.set(handle, started.turn_id);
    } catch (error) {
      this.#fail(handle, error);
    }
  }

  stop(handle: string): void {
    const turnId = this.#turnIds.get(handle);
    if (turnId) void botsIpc.cancel(turnId);
  }

  /** `/new`: keep the one conversation, shortened. */
  async compact(handle: string): Promise<void> {
    await botsIpc.compact(handle);
    if (this.selected === handle) await this.select(handle);
  }

  async create(bot: Partial<BotConfig> & { title: string; soul?: string }): Promise<Bot> {
    const created = await botsIpc.create(bot);
    this.bots = await botsIpc.list();
    await this.select(created.handle);
    return created;
  }

  async save(handle: string, config: BotConfig, docs: Partial<Record<BotDoc, string>>): Promise<void> {
    await botsIpc.update(handle, config);
    for (const [doc, text] of Object.entries(docs) as Array<[BotDoc, string]>) await botsIpc.writeDoc(handle, doc, text);
    this.bots = await botsIpc.list();
    if (this.selected === handle) this.detail = await botsIpc.get(handle);
  }

  async remove(handle: string): Promise<void> {
    await botsIpc.remove(handle);
    this.bots = await botsIpc.list();
    const next = { ...this.turns };
    delete next[handle];
    this.turns = next;
    if (this.selected === handle) {
      this.selected = null;
      this.detail = null;
      if (this.bots.length) await this.select(this.bots[0].handle);
    }
  }

  async saveRoutine(handle: string, routine: NewRoutine): Promise<void> {
    await botsIpc.saveRoutine(handle, routine, await currentModel());
    await this.#refreshRoutines(handle);
  }

  async deleteRoutine(handle: string, id: string): Promise<void> {
    await botsIpc.deleteRoutine(handle, id);
    await this.#refreshRoutines(handle);
  }

  async runRoutine(handle: string, id: string): Promise<void> {
    const started = await botsIpc.runRoutine(handle, id);
    this.#turnIds.set(handle, started.turn_id);
  }

  async #refreshRoutines(handle: string): Promise<void> {
    this.routines = { ...this.routines, [handle]: await botsIpc.routines(handle) };
  }

  #setWorking(handle: string, working: boolean): void {
    this.bots = this.bots.map((bot) => (bot.handle === handle ? { ...bot, working } : bot));
  }

  #fail(handle: string, error: unknown): void {
    const turns = this.turnsFor(handle);
    const last = turns[turns.length - 1];
    if (last) {
      last.run.error = error instanceof Error ? error.message : String(error);
      last.run.done = true;
      this.turns = { ...this.turns, [handle]: [...turns] };
    }
    this.#setWorking(handle, false);
  }

  #listen(): void {
    if (this.#listening) return;
    this.#listening = true;
    void onBotEvent((handle, event) => this.#apply(handle, event));
  }

  /** The turns an event lands in; a turn started elsewhere (a routine, a teammate) gets its own. */
  #turnsForEvent(handle: string, event: CodeAgentEvent): BotTurnView[] {
    const turns = this.turnsFor(handle);
    const last = turns[turns.length - 1];
    if (event.type !== 'agent_start') return turns;
    this.#setWorking(handle, true);
    const fresh = !last || last.run.startedAt || last.run.done;
    return fresh ? [...turns, foldTurn(null, { kind: 'user' }, [])] : turns;
  }

  #finish(handle: string, turn: BotTurnView): void {
    turn.run.done = true;
    this.#setWorking(handle, false);
    this.#turnIds.delete(handle);
    // The saved conversation names who asked and what; the routine list its last run.
    if (this.selected === handle) void this.select(handle);
  }

  #apply(handle: string, event: CodeAgentEvent): void {
    const turns = this.#turnsForEvent(handle, event);
    const last = turns[turns.length - 1];
    if (!last) return;
    applyCodeAgentEvent(last.run, event);
    if (event.type === 'approval_request') this.#askApproval(handle, event);
    if (event.type === 'agent_end') this.#finish(handle, last);
    this.turns = { ...this.turns, [handle]: [...turns] };
  }

  #askApproval(handle: string, event: Extract<CodeAgentEvent, { type: 'approval_request' }>): void {
    const args = event.args as { command?: string; path?: string } | null;
    void approvalsStore
      .request({ id: event.requestId, chatId: chatIdOf(handle), command: args?.command ?? args?.path ?? event.toolName, cwd: '' })
      .then((allow) => botsIpc.respondApproval(event.requestId, allow ? 'allow' : 'deny'));
  }
}

export const botsStore = new BotsStore();

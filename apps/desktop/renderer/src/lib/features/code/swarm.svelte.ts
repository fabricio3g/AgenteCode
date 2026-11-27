// Swarm mode on Desktop: each Code conversation's board and its switch.
//
// The board is session state in the core (`agente_core::swarm`): the main
// model plans cards with the `board` tool and the host starts each card as a
// created subagent. This store mirrors it per chat — read with
// `agente_board` (`board.get`), kept current by `board_update` events,
// switched with `board.enable`. It subscribes on its own, so the run store
// stays unaware of boards.

import { invoke } from '$lib/services/bridge';
import type { SwarmBoard, SwarmCard, SwarmCardStatus } from '$shared/agente-protocol';
import { subscribeToCodeAgentEvents } from './code-events.svelte';
import { codeStore } from './code.svelte';

/** The board's columns, left to right; failed cards sit with the done ones. */
const SWARM_COLUMNS: ReadonlyArray<{ id: 'backlog' | 'working' | 'review' | 'done'; statuses: SwarmCardStatus[] }> = [
  { id: 'backlog', statuses: ['backlog'] },
  { id: 'working', statuses: ['working'] },
  { id: 'review', statuses: ['review'] },
  { id: 'done', statuses: ['done', 'failed'] }
];

/** Cards per column, in board order. */
export function columnsOf(board: SwarmBoard | null): Array<{ id: string; cards: SwarmCard[] }> {
  const cards = board?.cards ?? [];
  return SWARM_COLUMNS.map((column) => ({ id: column.id, cards: cards.filter((card) => column.statuses.includes(card.status)) }));
}

/** How many cards are in each live state — the line under the board's title. */
export function tallyOf(board: SwarmBoard | null): { total: number; working: number; review: number; failed: number } {
  const cards = board?.cards ?? [];
  const count = (status: SwarmCardStatus) => cards.filter((card) => card.status === status).length;
  return { total: cards.length, working: count('working'), review: count('review'), failed: count('failed') };
}

class SwarmStore {
  boards = $state<Record<string, SwarmBoard>>({});
  #subscribed = false;

  #subscribe(): void {
    if (this.#subscribed) return;
    this.#subscribed = true;
    subscribeToCodeAgentEvents('*', (event) => {
      if (event.type === 'board_update') this.boards[event.chatId] = event.board;
    });
  }

  #sessionId(chatId: string): string | undefined {
    return codeStore.sessionIdFor(chatId);
  }

  boardFor(chatId: string): SwarmBoard | null {
    return this.boards[chatId] ?? null;
  }

  enabled(chatId: string): boolean {
    return !!this.boards[chatId]?.enabled;
  }

  /** Read the conversation's board, when it has an engine session yet. */
  async load(chatId: string): Promise<void> {
    this.#subscribe();
    const sessionId = this.#sessionId(chatId);
    if (!sessionId) return;
    const board = await invoke<SwarmBoard>('agente_board', { sessionId, action: 'get' });
    if (board) this.boards[chatId] = board;
  }

  /** Turn swarm mode on or off for the conversation; the cards stay either way. */
  async setEnabled(chatId: string, enabled: boolean): Promise<void> {
    this.#subscribe();
    await codeStore.ensureSession(chatId);
    const sessionId = this.#sessionId(chatId);
    if (!sessionId) throw new Error('Start a Code session first.');
    const board = await invoke<SwarmBoard>('agente_board', { sessionId, action: enabled ? 'enable' : 'disable' });
    if (board) this.boards[chatId] = board;
  }

  /**
   * Accept a card (a writer's changes are applied to the project), send it
   * back with a note (a fresh subagent retries with it), or give it up — the
   * same move the lead makes. Returns what the engine said happened.
   */
  async move(chatId: string, id: string, to: 'done' | 'backlog' | 'failed', note?: string): Promise<string> {
    const sessionId = this.#sessionId(chatId);
    if (!sessionId) throw new Error('Start a Code session first.');
    const result = await invoke<{ message: string; board: SwarmBoard }>('agente_board', { sessionId, action: 'move', id, to, note });
    if (result?.board) this.boards[chatId] = result.board;
    return result?.message ?? '';
  }

  /** Empty the board, keeping the switch. */
  async clear(chatId: string): Promise<void> {
    const sessionId = this.#sessionId(chatId);
    if (!sessionId) return;
    const board = await invoke<SwarmBoard>('agente_board', { sessionId, action: 'clear' });
    if (board) this.boards[chatId] = board;
  }
}

export const swarmStore = new SwarmStore();

// How an agent reply reads, top to bottom, the way assistant-ui's tool
// timeline and the TUI lay it out: what it said, and between the words one
// block of work — thoughts and tool calls in the order they happened — that
// folds to "3 steps · 2 files changed" once it is done. Under a live reply,
// one status line says what is happening right now, next to the composer.

import type { AgentStep } from '$lib/types/chat';
import type { CodeTodoItem } from '$shared/agente-protocol';
import type { CodeRunState, OrderedEntry } from './code-run';

export type WorkItem = { key: string; step?: AgentStep; thinking?: string };
export type ReplyBlock = { key: string; items: WorkItem[]; text?: undefined } | { key: string; text: string; items?: undefined };

/** Consecutive thoughts and steps become one work block; text stands between them. */
export function replyBlocks(entries: OrderedEntry[]): ReplyBlock[] {
  const blocks: ReplyBlock[] = [];
  for (const entry of entries) {
    const last = blocks[blocks.length - 1];
    if (entry.text !== undefined) {
      blocks.push({ key: entry.key, text: entry.text });
      continue;
    }
    const item: WorkItem = { key: entry.key, step: entry.step, thinking: entry.thinking };
    if (last?.items) last.items.push(item);
    else blocks.push({ key: entry.key, items: [item] });
  }
  return blocks;
}

export interface FileTotal {
  path: string;
  name: string;
  additions: number;
  deletions: number;
}

/** Every file a block's edits touched, once each, with its churn summed. */
export function changedFiles(items: WorkItem[]): FileTotal[] {
  const files = new Map<string, FileTotal>();
  for (const { step } of items) {
    if (step?.status === 'awaiting_approval' || step?.type === 'approval') continue;
    for (const stat of step?.diffStats ?? []) {
      const known = files.get(stat.path);
      if (known) {
        known.additions += stat.additions;
        known.deletions += stat.deletions;
      } else {
        files.set(stat.path, { path: stat.path, name: stat.path.split(/[\\/]/).pop() || stat.path, additions: stat.additions, deletions: stat.deletions });
      }
    }
  }
  return [...files.values()];
}

export function isRunning(step: AgentStep | undefined): boolean {
  return step?.status === 'running' || step?.status === 'pending';
}

export function needsAttention(step: AgentStep | undefined, approvals: ReadonlySet<string>): boolean {
  return !!step && (step.status === 'error' || step.status === 'awaiting_approval' || approvals.has(step.id));
}

export type LiveStatus =
  | { kind: 'approval' }
  | { kind: 'retry'; attempt: number }
  | { kind: 'preparing'; toolName: string; bytes: number }
  | { kind: 'running'; step: AgentStep }
  | { kind: 'thinking' }
  | { kind: 'writing' }
  | { kind: 'waiting'; quietMs: number };

/** Seconds of silence before the line admits it is waiting on the model. */
export const QUIET_MS = 8_000;

/**
 * What the run is doing right now, in the TUI's order of importance: you
 * (an approval), a retry, a tool call being written, a tool running, then
 * whatever the model streams last — thought or reply.
 */
export function liveStatus(run: Pick<CodeRunState, 'timeline' | 'steps' | 'preparing' | 'retrying' | 'lastEventAt'>, awaitingApproval: boolean, now = Date.now()): LiveStatus {
  if (awaitingApproval) return { kind: 'approval' };
  if (run.retrying) return { kind: 'retry', attempt: run.retrying.attempt };
  if (run.preparing) return { kind: 'preparing', toolName: run.preparing.toolName, bytes: run.preparing.bytes };
  const running = [...run.steps].reverse().find(isRunning);
  if (running) return { kind: 'running', step: running };
  const quietMs = run.lastEventAt ? now - run.lastEventAt : 0;
  if (quietMs >= QUIET_MS) return { kind: 'waiting', quietMs };
  const last = run.timeline[run.timeline.length - 1];
  if (last?.kind === 'thinking') return { kind: 'thinking' };
  if (last?.kind === 'text') return { kind: 'writing' };
  return { kind: 'waiting', quietMs };
}

/** The task the bar above the composer names: the one in progress, else the next, else the last. */
export function currentTodo(todos: CodeTodoItem[]): CodeTodoItem | undefined {
  return todos.find((todo) => todo.status === 'in_progress') ?? todos.find((todo) => todo.status === 'pending') ?? todos.at(-1);
}

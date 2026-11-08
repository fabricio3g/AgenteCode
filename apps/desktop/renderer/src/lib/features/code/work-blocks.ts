// How an agent reply reads, top to bottom, in the same order as the TUI: what it said, and between the words one
// block of work — thoughts and tool calls in the order they happened — that
// folds to "3 steps · 2 files changed" once it is done. Under a live reply,
// one status line says what is happening right now, next to the composer.

import type { AgentStep, CodeAgentFileChangeKind } from '$lib/types/chat';
import type { CodeRunState, OrderedEntry } from './code-run';

export type WorkItem = { key: string; step?: AgentStep; thinking?: string };
export type ReplyBlock =
  | { key: string; items: WorkItem[]; text?: undefined }
  | { key: string; text: string; items?: undefined };

/** Consecutive thoughts and steps become one work block, separated by text. */
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

/**
 * The key a work block's own disclosure uses.
 *
 * Prefixed, because the block used to borrow its first row's key — and a `task`
 * step hands that same key down to the child's card. One key, two disclosures:
 * opening the block opened the first child, and folding that child folded the
 * whole block, border and steps and all.
 */
export function workBlockKey(firstKey: string | undefined): string {
  return `block-${firstKey ?? 'work'}`;
}

export interface FileTotal {
  path: string;
  name: string;
  additions: number;
  deletions: number;
}

/** A file the agent edited, its churn summed and each edit's patch in order. */
export interface FileEdit extends FileTotal {
  kind: CodeAgentFileChangeKind;
  patches: string[];
}

/** Every file these steps edited, once each, with its churn summed (approvals don't count). */
export function editedFiles(steps: Array<AgentStep | undefined>): FileEdit[] {
  const files = new Map<string, FileEdit>();
  for (const step of steps) {
    if (step?.status === 'awaiting_approval' || step?.type === 'approval') continue;
    for (const stat of step?.diffStats ?? []) {
      const known = files.get(stat.path) ?? { path: stat.path, name: stat.path.split(/[\\/]/).pop() || stat.path, kind: stat.kind ?? 'modified', additions: 0, deletions: 0, patches: [] };
      known.additions += stat.additions;
      known.deletions += stat.deletions;
      if (stat.patch) known.patches.push(stat.patch);
      files.set(stat.path, known);
    }
  }
  return [...files.values()];
}

/** Every file a block's edits touched, once each, with its churn summed. */
export function changedFiles(items: WorkItem[]): FileTotal[] {
  return editedFiles(items.map((item) => item.step)).map(({ path, name, additions, deletions }) => ({ path, name, additions, deletions }));
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
  | { kind: 'starting' }
  | { kind: 'requesting' }
  | { kind: 'compacting' };

/** Seconds without a new engine event before adding a factual silence note. */
export const QUIET_MS = 8_000;

/**
 * What the run is doing right now, in the TUI's order of importance: you
 * (an approval), a retry, a tool call being written, a tool running, then
 * whatever the model streams last — thought or reply.
 */
export function liveStatus(run: Pick<CodeRunState, 'timeline' | 'steps' | 'preparing' | 'retrying' | 'lastEventAt' | 'phase'>, awaitingApproval: boolean, now = Date.now()): LiveStatus {
  if (awaitingApproval) return { kind: 'approval' };
  if (run.retrying) return { kind: 'retry', attempt: run.retrying.attempt };
  if (run.preparing) return { kind: 'preparing', toolName: run.preparing.toolName, bytes: run.preparing.bytes };
  const running = [...run.steps].reverse().find(isRunning);
  if (running) return { kind: 'running', step: running };
  void now;
  if (run.phase) return { kind: run.phase };
  const last = run.timeline[run.timeline.length - 1];
  if (last?.kind === 'thinking') return { kind: 'thinking' };
  if (last?.kind === 'text') return { kind: 'writing' };
  return { kind: 'starting' };
}

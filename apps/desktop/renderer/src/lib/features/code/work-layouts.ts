// One model of a run of work for the desktop work layouts (Settings →
// Appearance → Agent work). Every layout draws the same entries — what was
// done, to what, how it ended — so the layouts differ only in how they show
// it: a feed, a stream of files, a plan, diffs to review, a research trail, a
// timeline, tiles. Pure logic; the components draw and translate.

import type { Snippet } from 'svelte';
import type { AgentStep } from '$lib/types/chat';
import type { ToolKind } from '$shared/tool-kinds';
import { toolTarget } from '$lib/utils/tool-ui';
import { stepKind } from './activity';
import { editedFiles, isRunning, type FileEdit, type WorkItem } from './work-blocks';

export type EntryKind = ToolKind | 'thought';
export type EntryStatus = 'done' | 'running' | 'error' | 'ask';

export interface WorkEntry {
  key: string;
  item: WorkItem;
  step?: AgentStep;
  kind: EntryKind;
  status: EntryStatus;
  /** The step's own verb ("Read", "Run"). */
  label: string;
  /** What it touched: a path, a command, a query. */
  target: string;
  /** The last segment of a path target, else the target. */
  name: string;
  /** The folder a path target sits in, if any. */
  folder: string;
  additions: number;
  deletions: number;
  /** Non-empty output lines, trimmed. */
  output: string[];
  startedAt?: number;
  durationMs?: number;
}

const PATH_KINDS: ReadonlySet<EntryKind> = new Set(['read', 'list', 'edit']);

export function entryStatus(step: AgentStep): EntryStatus {
  if (step.status === 'awaiting_approval' || step.type === 'approval') return 'ask';
  if (step.status === 'error') return 'error';
  if (isRunning(step)) return 'running';
  return 'done';
}

function splitPath(target: string): { name: string; folder: string } {
  const parts = target.split(/[\\/]/).filter(Boolean);
  if (parts.length < 2) return { name: target, folder: '' };
  return { name: parts[parts.length - 1], folder: parts.slice(0, -1).join('/') };
}

export function workEntries(items: WorkItem[]): WorkEntry[] {
  return items.map((item) => {
    if (!item.step) {
      return { key: item.key, item, kind: 'thought', status: 'done', label: '', target: '', name: '', folder: '', additions: 0, deletions: 0, output: [] };
    }
    const step = item.step;
    const kind = stepKind(step);
    const target = toolTarget(step.toolName, step.detail) || step.detail?.split('\n')[0] || '';
    const { name, folder } = PATH_KINDS.has(kind) ? splitPath(target) : { name: target, folder: '' };
    return {
      key: item.key,
      item,
      step,
      kind,
      status: entryStatus(step),
      label: step.label,
      target,
      name,
      folder,
      additions: step.diffStats?.reduce((sum, file) => sum + file.additions, 0) ?? 0,
      deletions: step.diffStats?.reduce((sum, file) => sum + file.deletions, 0) ?? 0,
      output: (step.output ?? '').split('\n').map((line) => line.trim()).filter(Boolean),
      startedAt: step.startedAt,
      durationMs: step.durationMs
    };
  });
}

/** Explore-type kinds: what a run looks at before it changes anything. */
export const EXPLORE_KINDS: ReadonlySet<EntryKind> = new Set(['read', 'list', 'search', 'web', 'other']);

export interface WorkTotals {
  explored: number;
  searches: number;
  files: FileEdit[];
  commands: number;
  done: number;
  failed: number;
  running: number;
  total: number;
}

export function workTotals(entries: WorkEntry[]): WorkTotals {
  const steps = entries.filter((entry) => entry.step);
  return {
    explored: steps.filter((entry) => entry.kind === 'read' || entry.kind === 'list').length,
    searches: steps.filter((entry) => entry.kind === 'search' || entry.kind === 'web').length,
    files: editedFiles(steps.map((entry) => entry.step)),
    commands: steps.filter((entry) => entry.kind === 'command').length,
    done: steps.filter((entry) => entry.status === 'done').length,
    failed: steps.filter((entry) => entry.status === 'error').length,
    running: steps.filter((entry) => entry.status === 'running').length,
    total: steps.length
  };
}

export type PhaseKind = 'explore' | 'change' | 'run' | 'think' | 'delegate';

export interface WorkPhase {
  key: string;
  kind: PhaseKind;
  entries: WorkEntry[];
  status: EntryStatus;
}

function phaseOf(kind: EntryKind): PhaseKind {
  if (kind === 'thought') return 'think';
  if (kind === 'edit') return 'change';
  if (kind === 'command') return 'run';
  if (kind === 'subagent') return 'delegate';
  return 'explore';
}

/** Consecutive entries of one family become a phase: look, change, run, … */
export function workPhases(entries: WorkEntry[]): WorkPhase[] {
  const phases: WorkPhase[] = [];
  for (const entry of entries) {
    const kind = phaseOf(entry.kind);
    const last = phases.at(-1);
    if (last && last.kind === kind) last.entries.push(entry);
    else phases.push({ key: entry.key, kind, entries: [entry], status: 'done' });
  }
  for (const phase of phases) {
    const states = phase.entries.map((entry) => entry.status);
    phase.status = states.includes('ask') ? 'ask' : states.includes('running') ? 'running' : states.includes('error') ? 'error' : 'done';
  }
  return phases;
}

const URL_PATTERN = /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi;

/** The sites a step reached, from its target and its output, once each. */
export function entryDomains(entry: WorkEntry, limit = 5): string[] {
  const text = `${entry.target}\n${entry.step?.output ?? ''}`;
  const domains = new Set<string>();
  for (const match of text.matchAll(URL_PATTERN)) {
    domains.add(match[1].replace(/^www\./, '').toLowerCase());
    if (domains.size >= limit) break;
  }
  return [...domains];
}

/** One changed hunk's lines, at most `limit`, for a compact inline diff. */
export function diffPreview(patch: string | undefined, limit = 6): Array<{ sign: '+' | '-'; text: string }> {
  if (!patch) return [];
  const lines: Array<{ sign: '+' | '-'; text: string }> = [];
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+') || line.startsWith('-')) lines.push({ sign: line[0] as '+' | '-', text: line.slice(1) });
    if (lines.length >= limit) break;
  }
  return lines;
}

/** File-name colour family, so a stream of files is scannable by type. */
export function fileTone(name: string): 'code' | 'test' | 'style' | 'doc' | 'data' | 'other' {
  const lower = name.toLowerCase();
  if (/\.(test|spec)\.[a-z]+$/.test(lower)) return 'test';
  if (/\.(ts|tsx|js|jsx|mjs|cjs|svelte|vue|rs|go|py|rb|java|kt|swift|c|cc|cpp|h|cs)$/.test(lower)) return 'code';
  if (/\.(css|scss|less|sass)$/.test(lower)) return 'style';
  if (/\.(md|mdx|txt|rst)$/.test(lower)) return 'doc';
  if (/\.(json|toml|ya?ml|csv|xml|lock)$/.test(lower)) return 'data';
  return 'other';
}

type Translate = (key: string, options?: { values?: Record<string, string | number> }) => string;

/** "Read", "Running", … — the entry's verb in the reader's language. */
export function entryVerb(entry: WorkEntry, t: Translate): string {
  return t(`code.layout.verb.${entry.status === 'running' ? 'running' : 'done'}.${entry.kind}`);
}

/** What came back, in one line: "120 lines", "12 passing", "Waiting for you". */
export function entryResult(entry: WorkEntry, t: Translate): string {
  if (entry.status === 'ask') return t('code.layout.waiting');
  if (entry.status === 'running' || entry.additions || entry.deletions || !entry.output.length) return '';
  if (entry.kind === 'read') return t('code.stepResult.lines', { values: { n: entry.output.length } });
  if (entry.kind === 'list') return t('code.stepResult.entries', { values: { n: entry.output.length } });
  const first = entry.output[0].length > 96 ? `${entry.output[0].slice(0, 95)}…` : entry.output[0];
  return entry.output.length > 1 ? `${first} · ${t('code.stepResult.more', { values: { n: entry.output.length - 1 } })}` : first;
}

/** What every layout component receives from the work block. */
export interface WorkLayoutProps {
  entries: WorkEntry[];
  totals: WorkTotals;
  /** The block's summary line ("Editing 1 file · running 1 command"). */
  line: string;
  /** How long the run took, once nothing runs. */
  span?: number;
  live: boolean;
  open: boolean;
  ontoggle: () => void;
  /** The original row (a thought, a subagent card). */
  row: Snippet<[WorkItem]>;
  /** A step's detail without its row: the diff, the output. */
  detail: Snippet<[WorkItem]>;
  isOpen: (entry: WorkEntry) => boolean;
  toggleEntry: (entry: WorkEntry) => void;
}

/** A step a layout can open: something to show beyond its row. */
export function canOpen(entry: WorkEntry): boolean {
  const step = entry.step;
  if (!step || step.toolName === 'task') return false;
  return entry.output.length > 0 || !!step.diffStats?.length || !!step.toolInput || entry.status === 'running' || entry.status === 'ask' || (step.detail?.length ?? 0) > 60;
}

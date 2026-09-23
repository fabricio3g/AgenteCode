/** Shared helpers for the tool / reasoning chrome above an assistant answer. */

import type { AgentActivity } from '$lib/types/chat';
import { copy } from '$lib/copy';

export type ToolUiStatus = 'done' | 'running' | 'error' | 'pending' | 'awaiting_approval';

/**
 * The label shown for each agent activity.
 *
 * These verbs were previously spelled inline in seven files — `agent.ts`,
 * `app.svelte.ts`, `app-store-helpers.ts`, `AgentBlock.svelte`,
 * `DeepResearchWidget.svelte` and others — which is how the app ended up with
 * "Thinking", "Thinking...", and "Planning" all describing the same state.
 */
// Read on every call, not captured at import: `copy` follows the UI language.
const ACTIVITY_LABELS: Record<AgentActivity, () => string> = {
  planning: () => copy.status.planning,
  searching: () => copy.status.searching,
  reading: () => copy.status.reading,
  creating_files: () => copy.status.writing,
  writing: () => copy.status.writing,
  stopped: () => copy.tool.stopped,
  completed: () => copy.tool.done
};

export function activityLabel(activity: AgentActivity | undefined | null): string {
  return (activity && ACTIVITY_LABELS[activity]?.()) || copy.status.working;
}

export function titleCaseToolName(name: string): string {
  const text = String(name || '');
  // Only raw tool ids (`web_search`) are prettified; a label that is already
  // prose ("Edit src/index.ts") keeps its paths and casing.
  if (!/^[a-z0-9_]+$/.test(text)) return text;
  return text.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Format elapsed tool duration (ms) like assistant-ui ToolFallback. */
export function formatToolDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return '<1s';
  const seconds = ms / 1000;
  if (seconds < 10) return `${(Math.floor(seconds * 10) / 10).toFixed(1)}s`;
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}

export function formatReasoningDuration(seconds: number): string {
  const s = Number(seconds || 0);
  if (!Number.isFinite(s) || s <= 0) return '';
  if (s < 10) return s.toFixed(1);
  return String(Math.floor(s));
}

export function isCodeToolName(name: string): boolean {
  return /^(run[_\s-]?code|execute[_\s-]?(command|code)|bash|shell)$/i.test(String(name || '').trim());
}

export function toolStatusLabel(
  status: ToolUiStatus | string,
  opts?: { cancelled?: boolean }
): string {
  if (opts?.cancelled || (status === 'error' && opts?.cancelled)) return copy.tool.cancelled;
  if (status === 'awaiting_approval') return copy.tool.needsApproval;
  if (status === 'running' || status === 'pending') return '';
  if (status === 'error') return copy.tool.failed;
  return '';
}

/**
 * The quiet mode chip shown beside agent progress ("Deep", "Max", …).
 *
 * Returns `''` for plain chat, since an "Off" chip on every ordinary answer is
 * exactly the kind of redundant furniture this UI is meant to avoid.
 */
export function searchModeChip(mode: 'chat' | 'search' | 'deep' | 'max' | null | undefined): string {
  if (!mode || mode === 'chat') return '';
  return copy.searchModes[mode].label;
}

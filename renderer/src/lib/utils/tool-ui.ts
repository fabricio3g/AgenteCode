/** Shared helpers for assistant-ui–style tool / reasoning chrome. */

export type ToolUiStatus = 'done' | 'running' | 'error' | 'pending' | 'awaiting_approval';

export function titleCaseToolName(name: string): string {
  return String(name || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
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
  if (opts?.cancelled || (status === 'error' && opts?.cancelled)) return 'Cancelled';
  if (status === 'awaiting_approval') return 'Needs approval';
  if (status === 'running' || status === 'pending') return '';
  if (status === 'error') return 'Failed';
  return '';
}

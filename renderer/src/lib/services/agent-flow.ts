import type { AgentStep, AgentStopReason } from '$lib/types/chat';

export type ProgressSnapshot = {
  sourceCount: number;
  visibleFileCount: number;
  draftChars: number;
  observationCount: number;
};

export function classifyStopReason(reason?: string): AgentStopReason {
  const text = String(reason || '').toLowerCase();
  if (!text) return 'none';
  if (text.includes('timed out') || text.includes('timeout')) return 'timeout';
  if (text.includes('loop') || text.includes('repeated')) return 'loop';
  if (text.includes('tool') && (text.includes('limit') || text.includes('budget'))) return 'tool_limit';
  if (text.includes('iteration')) return 'iteration_limit';
  if (text.includes('requested file') || text.includes('missing requested') || text.includes('artifact')) return 'missing_artifacts';
  return 'error';
}

export function stoppedWarning(stopReason: AgentStopReason, reason: string, opts?: { workspace?: boolean }): string {
  const code = !!opts?.workspace;
  switch (stopReason) {
    case 'timeout':
      return code
        ? 'Timed out before finishing. Here is a partial coding summary.'
        : 'Timed out before finishing. Here is a partial answer from what was already found.';
    case 'loop':
      return code
        ? 'Got stuck repeating explore steps. Here is a partial summary.'
        : 'Got stuck repeating steps. Here is a partial answer from what was already found.';
    case 'tool_limit':
      return code
        ? 'Hit the tool budget. Here is a partial coding summary.'
        : 'Reached the tool limit. Here is a partial answer from what was already found.';
    case 'iteration_limit':
      return code
        ? 'Reached the step limit. Here is a partial coding summary — ask to continue if needed.'
        : 'Reached the step limit. Here is a partial answer from what was already found.';
    case 'missing_artifacts':
      return 'Could not create every requested file. Here is what was available from this session.';
    default:
      return reason || 'Stopped before finishing. Here is a partial answer from what was already found.';
  }
}

export function hasVisibleArtifact(files: Record<string, string>): boolean {
  return Object.keys(files).some((path) => !path.startsWith('__')) || !!files['__preview__.html'];
}

export function visibleFileCount(files: Record<string, string>): number {
  return Object.keys(files).filter((path) => !path.startsWith('__')).length;
}

export function hasProgressSince(snapshots: ProgressSnapshot[], minDraftGrowth: number): boolean {
  if (snapshots.length < 2) return true;
  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  return (
    last.sourceCount > first.sourceCount ||
    last.visibleFileCount > first.visibleFileCount ||
    last.observationCount > first.observationCount ||
    (last.draftChars - first.draftChars) >= minDraftGrowth
  );
}

export function isWebsiteBuildRequest(prompt: string): boolean {
  const normalized = String(prompt || '');
  if (!normalized) return false;
  return /\b(website|web\s*site|webpage|web\s*page|landing\s*page|landing|site|homepage|index\.html|html|css|javascript|script\.js)\b/i.test(normalized);
}

export function finalizeAgentSteps(steps: AgentStep[], hasError: boolean): void {
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (step.status !== 'running') continue;
    if (hasError) {
      step.status = 'error';
      if (!step.detail) step.detail = 'Stopped before completion';
      continue;
    }
    step.status = 'done';
    if (index === steps.length - 1 && step.type === 'thinking') {
      step.detail = 'Response ready';
    }
  }
}

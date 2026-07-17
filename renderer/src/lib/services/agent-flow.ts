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
        ? 'Agent timed out before finishing; returned a partial coding summary.'
        : 'Agent timed out and returned only gathered evidence.';
    case 'loop':
      return code
        ? 'Agent got stuck repeating explore steps; returned a partial summary.'
        : 'Agent encountered a loop and returned only gathered evidence.';
    case 'tool_limit':
      return code
        ? 'Agent hit the tool budget; returned a partial coding summary.'
        : 'Agent reached the tool limit and returned only gathered evidence.';
    case 'iteration_limit':
      return code
        ? 'Agent reached the step limit; returned a partial coding summary. Ask to continue if needed.'
        : 'Agent reached the iteration limit and returned only gathered evidence.';
    case 'missing_artifacts':
      return 'Requested files could not all be created; returned only gathered evidence.';
    default:
      return reason || 'Agent stopped before normal completion.';
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

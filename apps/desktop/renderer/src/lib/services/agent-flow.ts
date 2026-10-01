import type { AgentStep, AgentStopReason } from '$lib/types/chat';

export type ProgressSnapshot = {
  sourceCount: number;
  visibleFileCount: number;
  draftChars: number;
  observationCount: number;
};

export function stoppedWarning(
  stopReason: AgentStopReason,
  reason: string,
  opts?: { workspace?: boolean; research?: boolean }
): string {
  const code = !!opts?.workspace;
  const research = !!opts?.research;
  // Research product path: never frame a sourced report as a step-limit / agent failure.
  if (research && !code) {
    switch (stopReason) {
      case 'timeout':
        return 'Research timed out; the report uses sources retrieved so far.';
      case 'loop':
      case 'tool_limit':
      case 'iteration_limit':
        return '';
      case 'missing_artifacts':
        return 'Could not create every requested file. Here is the research available from this session.';
      default:
        return reason || '';
    }
  }
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
  return /\b(build|create|make|generate|write|design|develop)\b[\s\S]{0,100}\b(website|web\s*site|webpage|web\s*page|landing\s*page|homepage|index\.html)\b/i.test(normalized);
}

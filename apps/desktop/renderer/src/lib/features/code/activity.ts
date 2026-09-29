// A run of tool calls, read at a glance: "Read 8 files · searched 2 · ran 1
// command". The rows stay one click away.

import type { AgentStep } from '$lib/types/chat';
import { toolKind, type ToolKind } from '$shared/tool-kinds';

/** Order the counts appear in the summary line. */
const ORDER: ToolKind[] = ['edit', 'command', 'read', 'list', 'search', 'web', 'subagent', 'other'];

export function stepKind(step: AgentStep): ToolKind {
  return toolKind(step.toolName);
}

/** Files an edit step touched (an edit to the same file twice counts once). */
function editedFiles(steps: AgentStep[]): number {
  const paths = steps.flatMap((step) => {
    const files = [...(step.fileChanges ?? []), ...(step.diffStats ?? [])].map((file) => file.path);
    return files.length ? files : [step.detail?.split('\n')[0] || step.id];
  });
  return new Set(paths).size;
}

export interface ActivityCount {
  kind: ToolKind;
  count: number;
}

/** Per-kind counts for a run of steps, in reading order, and whether any is still going. */
export function activitySummary(steps: AgentStep[]): { counts: ActivityCount[]; running: boolean } {
  const counts = ORDER.map((kind) => {
    const ofKind = steps.filter((step) => stepKind(step) === kind);
    return { kind, count: kind === 'edit' ? (ofKind.length ? editedFiles(ofKind) : 0) : ofKind.length };
  }).filter((entry) => entry.count > 0);
  return { counts, running: steps.some((step) => step.status === 'running' || step.status === 'pending') };
}

import type { AgentStep } from '$lib/types/chat';

export type ActivityKind = 'commands' | 'edits' | 'reads';

/** Shared by the compact group and its individual tool rows. */
export function activityKind(step: AgentStep): ActivityKind | undefined {
  if (step.toolName === 'bash' || step.type === 'executing') return 'commands';
  if (step.toolName === 'edit' || step.toolName === 'write' || step.type === 'writing') return 'edits';
  if (['read', 'grep', 'ls'].includes(step.toolName ?? '') || step.type === 'reading') return 'reads';
  return undefined;
}

export function activitySummary(steps: AgentStep[]) {
  const active = steps.filter((step) => step.status === 'running' || step.status === 'pending');
  const counted = active.length ? active : steps;
  const kind = steps[0] ? activityKind(steps[0]) : undefined;
  const count = kind === 'edits'
    ? new Set(counted.flatMap((step) => {
        const paths = [...(step.fileChanges ?? []), ...(step.diffStats ?? [])].map((file) => file.path);
        return paths.length ? paths : [step.detail?.split('\n')[0] || step.id];
      })).size
    : counted.length;
  return { kind, running: active.length > 0, count };
}

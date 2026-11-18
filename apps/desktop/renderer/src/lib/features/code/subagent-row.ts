// Reading a subagent as one row.
//
// A spawn reaches the transcript as two unrelated things: the parent's `task`
// tool step, and the child's own card, which the runtime ids from the request's
// `task_id` (a fresh uuid). Nothing on the wire joins them, so the row for a
// spawn and the row for its child were drawn twice — once as
// `Task {"subagent_type":…}` and once as a card. These helpers make them one.

import type { AgentStep } from '$lib/types/chat';
import type { CodeChild } from '$shared/agente-protocol';
import { toolKind } from '$shared/tool-kinds';
import { titleCaseToolName } from '$lib/utils/tool-ui';

/**
 * The `task` step a newly appeared child belongs to, or `undefined`.
 *
 * `child_started` copies `kind` and `description` straight out of the same
 * request the parent sent, so the description the step carries is the same
 * string the child reports. Two spawns that asked for the same description pair
 * in the order they were admitted.
 */
export function linkChildToStep(steps: AgentStep[], description: string): string | undefined {
  if (!description) return undefined;
  return steps.find((step) => step.toolName === 'task' && !step.subagentId && step.detail === description)?.id;
}

/**
 * The children no step points at: background spawns, and any the transcript
 * lost track of. They still need a row, so the group renders them.
 */
export function unlinkedChildren(children: CodeChild[], steps: AgentStep[]): CodeChild[] {
  const linked = new Set(steps.map((step) => step.subagentId).filter(Boolean));
  return children.filter((child) => !linked.has(child.id));
}

/** How long a child has been (or was) running, from its renderer-stamped times. */
export function childElapsedMs(child: CodeChild, now: number): number | undefined {
  if (child.startedAt === undefined) return undefined;
  return Math.max(0, (child.finishedAt ?? now) - child.startedAt);
}

/**
 * The child a `task` step stands for, when the runtime has not reported it.
 *
 * A spawn's card normally arrives a moment after the step; until then — and in
 * an old saved turn whose children were never recorded — the step's own
 * arguments still say everything the row needs, so it draws the same shape
 * instead of falling back to a generic tool row.
 */
export function childFromStep(step: AgentStep): CodeChild {
  return {
    id: step.id,
    kind: step.subagentType || 'subagent',
    description: step.detail || '',
    status: step.status === 'done' ? 'done' : step.status === 'error' ? 'error' : 'running',
    text: '',
    summary: step.output,
    tools: [],
    model: step.model,
    // Zeroed here rather than through `emptySpend` in code-run.ts: this module
    // is imported by that one, and a value cycle between them is not worth a
    // shared constant.
    spend: { costUsd: 0, estimated: false, unpriced: true, promptTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  };
}

/** The tool a child is on right now, for the one line that says what it is doing. */
function childCurrentTool(child: CodeChild): string | undefined {
  for (let index = child.tools.length - 1; index >= 0; index--) {
    if (child.tools[index]!.status === 'running') return child.tools[index]!.name;
  }
  return undefined;
}

/**
 * What a running child is doing, in one word.
 *
 * A child's tool events carry the core tool names (`read_file`, not the UI's
 * `read`), so the kind decides the verb and an unknown name falls back to its
 * tidied id. The child's own arguments never reach the parent, so the row says
 * `Reading` rather than naming the file.
 */
const KIND_VERBS: Record<ReturnType<typeof toolKind>, string> = {
  read: 'Reading',
  list: 'Listing',
  search: 'Searching',
  edit: 'Editing',
  command: 'Running',
  web: 'Browsing',
  subagent: 'Delegating',
  other: 'Using'
};

export function childActivity(child: CodeChild): string | undefined {
  const tool = childCurrentTool(child);
  if (!tool) return undefined;
  const kind = toolKind(tool);
  return kind === 'other' ? titleCaseToolName(tool) : KIND_VERBS[kind];
}

/**
 * Every child this conversation has spawned, newest first: the saved turns'
 * `codeChildren` plus the live run's, the live copy winning for a child that
 * is in both (a turn's own message carries a snapshot while it streams).
 */
export function sessionChildren(messages: ReadonlyArray<{ metadata?: { codeChildren?: CodeChild[] } }>, live: readonly CodeChild[] = []): CodeChild[] {
  const byId = new Map<string, CodeChild>();
  for (const message of messages) for (const child of message.metadata?.codeChildren ?? []) byId.set(child.id, child);
  for (const child of live) byId.set(child.id, child);
  return [...byId.values()].reverse();
}

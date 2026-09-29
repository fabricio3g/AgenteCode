// The plan an agent presents in plan mode (the `present_plan` tool), and
// the three answers the TUI offers: accept and build it, ask for another,
// or comment on it.

import type { ChatMessage } from '$lib/types/chat';

export interface PresentedPlan {
  /** Where the plan was saved in the project (e.g. .agente/plan.md). */
  path: string;
  title: string;
  body: string;
}

/** The plan in a `present_plan` result: `__PLAN_READY__`, path, title, body. */
export function parsePlan(output: string | undefined): PresentedPlan | null {
  if (!output?.includes('__PLAN_READY__')) return null;
  const after = (marker: string) => output.split(marker)[1] ?? '';
  const path = after('__PLAN_READY__').split('__PLAN_TITLE__')[0].trim();
  const title = after('__PLAN_TITLE__').split('__PLAN_BODY__')[0].trim();
  const body = after('__PLAN_BODY__').trim();
  if (!body) return null;
  return { path, title: title || 'Plan', body };
}

/** The plan waiting for an answer: presented in the last reply, with nothing said since. */
export function pendingPlan(messages: ChatMessage[]): PresentedPlan | null {
  const last = messages.at(-1);
  if (!last || last.role !== 'assistant') return null;
  const step = [...(last.agentSteps ?? [])].reverse().find((item) => item.toolName === 'present_plan' && item.status === 'done');
  return parsePlan(step?.output);
}

export function acceptMessage(plan: PresentedPlan): string {
  return `User accepted the plan (${plan.path || 'the plan'}). Implement it now. Follow the plan; only ask if blocked.`;
}

export const REDO_MESSAGE = 'User rejected this plan. Produce a different plan via present_plan. Do not reuse the same structure or steps.';

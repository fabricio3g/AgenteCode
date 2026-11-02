import type { AgentStep } from '$lib/types/chat';
const LIMIT = 32_768;
export function traceText(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) || '';
  return text.length > LIMIT ? `${text.slice(0, LIMIT)}\n… truncated` : text;
}
export function startDesignToolStep(id: string, name: string, label: string, args: Record<string, unknown>, now = Date.now()): AgentStep {
  const detail = [args.action, args.path, args.page, args.query].filter(value => typeof value === 'string' && value).join(' · ');
  return { id, type: name === 'design_3d' ? 'tool' : name.includes('preview') || name.includes('motion') ? 'preview' : name.includes('read') || name.includes('list') ? 'reading' : 'tool', toolName:name, label, detail, toolInput:traceText(args), status:'running', startedAt:now };
}
export function finishDesignToolStep(step: AgentStep, output: string, failed = false, now = Date.now()) {
  step.output = traceText(output);
  step.status = failed ? 'error' : 'done';
  step.durationMs = Math.max(0, now - (step.startedAt ?? now));
}

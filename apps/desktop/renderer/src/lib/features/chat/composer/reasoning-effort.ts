import type { ReasoningLevel } from '$lib/types/chat';

/** How many of the meter's four bars a level fills. Auto (null) shows none filled. */
export function effortBars(level: ReasoningLevel | null): number {
  switch (level) {
    case null:
    case 'off':
    case 'disabled':
    case 'none':
      return 0;
    case 'minimal':
    case 'low':
      return 1;
    case 'medium':
    case 'default':
    case 'enabled':
    case 'on':
      return 2;
    case 'high':
      return 3;
    case 'xhigh':
    case 'max':
      return 4;
    default:
      return 2;
  }
}


/** A thinking-token budget as people read it: 512, 2k, 24k, 1.5M. */
export function formatBudget(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) {
    const k = tokens / 1024;
    return `${Number.isInteger(k) ? k : Math.round(k * 10) / 10}k`;
  }
  return `${Math.round(tokens / 100_000) / 10}M`;
}

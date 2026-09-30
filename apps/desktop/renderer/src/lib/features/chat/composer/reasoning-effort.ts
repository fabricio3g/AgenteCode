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


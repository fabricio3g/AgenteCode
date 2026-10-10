/** Shared animation states for every chat and activity indicator. */
export type TileMeterMode = 'busy' | 'quiet' | 'attention' | 'stopped';
export const STALLED_MS = 1_200;

export function meterMode(
  input: { attention: boolean; working: boolean; lastEventAt?: number; stopping?: boolean },
  now = Date.now()
): TileMeterMode {
  if (input.stopping) return 'stopped';
  if (input.attention) return 'attention';
  if (!input.working) return 'quiet';
  return input.lastEventAt === undefined || now - input.lastEventAt < STALLED_MS ? 'busy' : 'quiet';
}


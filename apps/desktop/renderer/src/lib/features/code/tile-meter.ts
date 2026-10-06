/**
 * The tile meter's vocabulary, in one place: how alive a run is, and what a
 * run's live state resolves to.
 *
 * Two very different surfaces wear the same meter — the status row under a live
 * reply, and the "back to latest" button that has to carry the same news while
 * the status row is scrolled off-screen — so neither one decides for itself.
 * `runMeterMode` is the only mapping from a Code run to weather, and
 * `meterMode` is the same ladder for callers that only know booleans.
 */

import type { CodeRunState } from './code-run';
import { liveStatus, type LiveStatus } from './work-blocks';

/** The four moods the meter can show (see TileMeter.svelte for the paint). */
export type TileMeterMode = 'busy' | 'quiet' | 'attention' | 'stopped';

/** Silence after which the rain slows to a drizzle: nothing is arriving. */
export const STALLED_MS = 1_200;

/** What is happening is a question put to the reader, not progress. */
const ATTENTION: ReadonlySet<LiveStatus['kind']> = new Set(['approval', 'retry']);

/** The engine is producing: a tool running, a call being written, a reply or a thought. */
const WORKING: ReadonlySet<LiveStatus['kind']> = new Set(['running', 'writing', 'preparing', 'thinking']);

/** The run fields the meter reads; a whole `CodeRunState` satisfies this. */
export type MeterRun = Pick<CodeRunState, 'timeline' | 'steps' | 'preparing' | 'retrying' | 'lastEventAt' | 'phase' | 'stopping'>;

/**
 * A mood from the three facts every surface has: is an answer owed, is the
 * engine working, and when did it last say anything.
 *
 * Stopping outranks the rest: a run told to stop is unwinding, and must not go
 * on looking busy for the round trip. No clock at all means the caller only
 * knows a run is live, which reads as working.
 */
export function meterMode(
  input: { attention: boolean; working: boolean; lastEventAt?: number; stopping?: boolean },
  now = Date.now()
): TileMeterMode {
  if (input.stopping) return 'stopped';
  if (input.attention) return 'attention';
  if (!input.working) return 'quiet';
  return input.lastEventAt === undefined || now - input.lastEventAt < STALLED_MS ? 'busy' : 'quiet';
}

/**
 * The mood of a Code run. `liveStatus` already decides what is happening, in
 * the order that matters (you, a retry, a tool being written, a tool running,
 * then what the model streams); this only turns that answer into weather.
 */
export function runMeterMode(run: MeterRun, awaitingApproval: boolean, now = Date.now()): TileMeterMode {
  const status = liveStatus(run, awaitingApproval, now);
  return meterMode(
    { stopping: run.stopping, attention: ATTENTION.has(status.kind), working: WORKING.has(status.kind), lastEventAt: run.lastEventAt },
    now
  );
}

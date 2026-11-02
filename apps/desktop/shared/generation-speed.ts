/**
 * How fast one reply streamed, in tokens per second.
 *
 * This is an **observation of the stream we received**, not a property of the
 * model: a served model's real throughput depends on the provider's queue, the
 * batch it landed in, the network and the account's rate limit. Two runs of the
 * same model on the same prompt can differ by an order of magnitude. So the
 * number is scoped to the reply it came from, and it is only reported when the
 * sample can carry it:
 *
 * 1. **Measure the stream, not the report.** The window is the interval
 *    between the first and the last output event. Timing to the `call_usage`
 *    report instead — which arrives after the provider has finished and closed
 *    the stream — added that pause to the denominator, so a short answer read
 *    as half its real speed.
 * 2. **Count the tokens the window actually holds.** N tokens arrive across
 *    N-1 gaps: the first one is already there when the clock starts and the
 *    last one closes the window. Dividing N by the window overstates every
 *    short answer.
 * 3. **Stay quiet when the sample is too small to mean anything.** Eight tokens
 *    over a third of a second is the floor; below it the noise (one slow delta,
 *    one batch arriving late) is larger than the measurement, and showing a
 *    confident number would be inventing knowledge nobody has.
 */
import type { RuntimeEvent } from './agente-protocol.gen.ts';

export const MIN_SPEED_SAMPLE_TOKENS = 8;
export const MIN_SPEED_SAMPLE_MS = 300;

export function generationRate(tokens: number | undefined, milliseconds: number | undefined): number | undefined {
  if (!Number.isFinite(tokens) || !Number.isFinite(milliseconds)) return undefined;
  // N tokens across the N-1 gaps the window holds; fewer than two spans none.
  const counted = tokens !== undefined && tokens >= 2 ? tokens - 1 : 0;
  if (counted + 1 < MIN_SPEED_SAMPLE_TOKENS) return undefined;
  if (!milliseconds || milliseconds < MIN_SPEED_SAMPLE_MS) return undefined;
  const rate = (counted * 1000) / milliseconds;
  return Number.isFinite(rate) && rate > 0 ? rate : undefined;
}

/** Per model call. Request setup, tool execution and approval waits never enter it. */
export class GenerationTimer {
  private firstAt?: number;
  private lastAt?: number;
  private updates = 0;

  record(at: number): void {
    if (!Number.isFinite(at) || at < 0) return;
    this.firstAt ??= at;
    this.lastAt = at;
    this.updates++;
  }

  /** The streaming window itself: first output event to last, nothing after it. */
  duration(): number | undefined {
    // A response delivered all at once has no measurable streaming interval.
    if (this.updates < 2 || this.firstAt === undefined || this.lastAt === undefined) return undefined;
    const window = this.lastAt - this.firstAt;
    return Number.isFinite(window) && window > 0 ? window : undefined;
  }

  reset(): void {
    this.firstAt = undefined;
    this.lastAt = undefined;
    this.updates = 0;
  }
}

/** The same call boundaries and output clock for Code, Home and Design. */
export class RuntimeGenerationTimer {
  private readonly timer = new GenerationTimer();
  private outputBytes = 0;

  observe(event: RuntimeEvent, at: number): number | undefined {
    if (event.type === 'assistant_delta' && event.text || event.type === 'reasoning_delta' && event.text) {
      this.timer.record(at);
    } else if (event.type === 'generation_progress') {
      // Progress is cumulative; a heartbeat with the same byte count is silence.
      if (event.output_bytes > this.outputBytes) this.timer.record(at);
      this.outputBytes = event.output_bytes;
    } else if (event.type === 'call_usage') {
      const duration = this.timer.duration();
      this.reset();
      return duration;
    } else if (['thinking', 'turn_started', 'turn_finished', 'turn_cancelled', 'turn_failed', 'retry', 'compaction_started', 'tool_proposed'].includes(event.type)) {
      this.reset();
    }
    return undefined;
  }

  private reset(): void {
    this.timer.reset();
    this.outputBytes = 0;
  }
}

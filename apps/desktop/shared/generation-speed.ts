/** A rate needs reported output tokens and time spent streaming this call. */
export function generationRate(tokens: number | undefined, milliseconds: number | undefined): number | undefined {
  if (!Number.isFinite(tokens) || !Number.isFinite(milliseconds) || !tokens || tokens <= 0 || !milliseconds || milliseconds <= 0) return undefined;
  const rate = tokens * 1000 / milliseconds;
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

  duration(at: number): number | undefined {
    // A response delivered all at once has no measurable streaming interval.
    if (this.updates < 2 || this.firstAt === undefined || this.lastAt === undefined || this.lastAt <= this.firstAt || !Number.isFinite(at) || at <= this.firstAt) return undefined;
    return at - this.firstAt;
  }

  reset(): void { this.firstAt = undefined; this.lastAt = undefined; this.updates = 0; }
}

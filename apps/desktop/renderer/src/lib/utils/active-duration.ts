/** A stopwatch that counts active intervals and excludes pauses. */
export class ActiveDuration {
  private accumulated = 0;
  private started: number | undefined;

  resume(now = performance.now()): void {
    this.started ??= now;
  }

  pause(now = performance.now()): void {
    this.accumulated = this.elapsed(now);
    this.started = undefined;
  }

  elapsed(now = performance.now()): number {
    return this.accumulated + (this.started === undefined ? 0 : Math.max(0, now - this.started));
  }
}

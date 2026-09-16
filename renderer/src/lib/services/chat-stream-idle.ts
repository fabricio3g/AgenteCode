/**
 * Renderer-side idle watchdog for IPC streams.
 *
 * Every stream client awaits a promise settled only by an explicit terminal
 * event (`done` / `cancelled` / `error`). The main process has a 10-minute
 * *total* watchdog, but a provider whose stream stalls and ignores the abort
 * signal never emits anything at all, so the renderer waits forever and the
 * run stays active ("planning" with a permanent stop button).
 *
 * This fires after a period of complete silence so the caller can cancel and
 * fail visibly. One shared bound keeps all stream clients consistent.
 */

export const STREAM_IDLE_TIMEOUT_MS = 4 * 60 * 1000;

export function streamIdleTimeoutMessage(): string {
  return `Stream timed out — no data for ${Math.round(STREAM_IDLE_TIMEOUT_MS / 60_000)} minutes.`;
}

export interface StreamIdleWatchdog {
  /** (Re)start the silence timer. Call on start and on every stream event. */
  arm(): void;
  /** Stop the timer; call when the stream settles. */
  clear(): void;
}

export function createStreamIdleWatchdog(options: {
  timeoutMs?: number;
  onStall: () => void;
}): StreamIdleWatchdog {
  const timeoutMs = options.timeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    arm() {
      clear();
      timer = setTimeout(() => {
        timer = null;
        options.onStall();
      }, timeoutMs);
    },
    clear
  };
}

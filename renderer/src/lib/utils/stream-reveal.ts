/** Smooth bursty token delivery without changing the stored response. */
export function createStreamReveal(initial: string, render: (value: string) => void) {
  let shown = initial;
  let target = initial;
  let frame: number | undefined;
  let lastTime = 0;
  let disposed = false;

  function cancel() {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    lastTime = 0;
  }

  function flush() {
    cancel();
    if (shown !== target) render(shown = target);
  }

  function advance(time: number) {
    frame = undefined;
    if (disposed) return;
    const elapsed = lastTime ? Math.min(64, time - lastTime) : 16;
    lastTime = time;
    const remaining = target.length - shown.length;
    // A ~90ms time constant smooths regular chunks, while larger bursts catch
    // up proportionally. Frame rate doesn't set the typing speed.
    let end = shown.length + Math.max(1, Math.ceil(remaining * (1 - Math.exp(-elapsed / 90))));
    end = Math.min(end, target.length);
    // Never split a UTF-16 surrogate pair (emoji and supplementary characters).
    if (end < target.length && /[\uD800-\uDBFF]/.test(target[end - 1])) end++;
    render(shown = target.slice(0, end));
    if (shown !== target) frame = requestAnimationFrame(advance);
    else lastTime = 0;
  }

  return {
    update(value: string, animate: boolean) {
      if (disposed) return;
      target = value;
      if (!animate || !target.startsWith(shown)) return flush();
      if (target !== shown && frame === undefined) frame = requestAnimationFrame(advance);
    },
    flush,
    dispose() { disposed = true; cancel(); }
  };
}

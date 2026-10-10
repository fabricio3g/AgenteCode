/** Read size after the observer delivery cycle, avoiding layout feedback loops. */
export function observeViewerSize(node: HTMLElement, update: () => void): () => void {
  let frame = 0;
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
    cancelAnimationFrame(frame); frame = requestAnimationFrame(update);
  });
  observer?.observe(node);
  return () => { observer?.disconnect(); cancelAnimationFrame(frame); };
}

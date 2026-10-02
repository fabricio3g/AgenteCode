/** Follow a drag even when Electron releases capture outside its original handle. */
export function startPointerGesture(event: PointerEvent, move: (event: PointerEvent) => void, finish: (cancelled: boolean) => void): () => void {
  const target = event.currentTarget as HTMLElement;
  target.setPointerCapture(event.pointerId);
  let ended = false;
  const end = (cancelled: boolean) => {
    if (ended) return;
    ended = true;
    window.removeEventListener('pointermove', moved, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', abort, true);
    window.removeEventListener('keydown', key, true);
    window.removeEventListener('workspace-scope-change', cancel);
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
    finish(cancelled);
  };
  const moved = (next: PointerEvent) => { if (next.pointerId === event.pointerId) move(next); };
  const up = (next: PointerEvent) => { if (next.pointerId === event.pointerId) end(false); };
  const abort = (next: PointerEvent) => { if (next.pointerId === event.pointerId) end(true); };
  const cancel = () => end(true);
  const key = (next: KeyboardEvent) => {
    if (next.key !== 'Escape') return;
    next.preventDefault(); next.stopImmediatePropagation(); cancel();
  };
  window.addEventListener('pointermove', moved, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', abort, true);
  window.addEventListener('keydown', key, true);
  window.addEventListener('workspace-scope-change', cancel);
  return cancel;
}

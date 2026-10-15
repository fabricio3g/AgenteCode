export const LATEST_BUTTON_DISTANCE = 80;
const RESUME_DISTANCE = 32;

export type ScrollGeometry = Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'>;

export function distanceFromLatest(viewport: ScrollGeometry): number {
  return Math.max(0, viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop);
}

/** Growth is not scroll intent: only moving upward pauses the live edge. */
export class ConversationFollow {
  following = true;
  private previousTop = 0;

  pause(): void { this.following = false; }

  resume(top = this.previousTop): void {
    this.following = true;
    this.previousTop = top;
  }

  observe(viewport: ScrollGeometry): void {
    // Closing a disclosure can clamp scrollTop; that is not an upward gesture.
    const priorTop = Math.min(this.previousTop, Math.max(0, viewport.scrollHeight - viewport.clientHeight));
    if (viewport.scrollTop < priorTop - 1) this.pause();
    else if (distanceFromLatest(viewport) <= RESUME_DISTANCE) this.following = true;
    this.previousTop = viewport.scrollTop;
  }
}

/** Pause before a pending resize callback can pull a wheel/key gesture back. */
export function pauseOnScrollIntent(node: HTMLElement, follow: ConversationFollow) {
  const wheel = (event: WheelEvent) => {
    if (event.deltaY < 0) follow.pause();
  };
  const key = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, [contenteditable="true"]')) return;
    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) follow.pause();
  };
  node.addEventListener('wheel', wheel, { passive: true });
  node.addEventListener('keydown', key);
  return { destroy() {
    node.removeEventListener('wheel', wheel);
    node.removeEventListener('keydown', key);
  } };
}

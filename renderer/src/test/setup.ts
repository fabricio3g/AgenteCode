import { afterEach } from 'vitest';

if (typeof Element !== 'undefined' && !Element.prototype.animate) {
  Element.prototype.animate = function () {
    let cancelled = false;
    const animation = {
      cancel: () => { cancelled = true; },
      finish: () => { if (!cancelled) animation.onfinish?.(new Event('finish')); },
      onfinish: null as ((event: Event) => void) | null,
      finished: Promise.resolve(),
      playState: 'finished',
    };
    queueMicrotask(() => {
      if (!cancelled) animation.onfinish?.(new Event('finish'));
    });
    return animation as unknown as Animation;
  };
}

afterEach(() => {
  if (typeof document !== 'undefined') {
    document.body.innerHTML = '';
    document.head.querySelectorAll('[data-vitest]').forEach((node) => node.remove());
  }
});

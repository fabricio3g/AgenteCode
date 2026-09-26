import { afterEach } from 'vitest';
import { addMessages, init } from 'svelte-i18n';
import en from '../lib/locales/en.json';

// Components read their text through svelte-i18n; tests render them in English.
addMessages('en', en);
init({ fallbackLocale: 'en', initialLocale: 'en' });

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

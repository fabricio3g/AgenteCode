import { appearanceStore } from './appearance.svelte';

/**
 * Facade over `appearanceStore` so existing callers (`themeStore.current`,
 * `themeStore.toggle()`, `themeStore.set()`) stay in sync with the full
 * Settings → Appearance preferences.
 */
class ThemeStore {
  get current(): 'light' | 'dark' {
    return appearanceStore.resolvedMode;
  }

  toggle(origin?: { x: number; y: number }) {
    appearanceStore.toggleMode(origin);
  }

  set(next: 'light' | 'dark') {
    appearanceStore.setMode(next);
  }
}

export const themeStore = new ThemeStore();

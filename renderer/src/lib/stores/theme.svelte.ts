import { loadTheme, saveTheme } from '$lib/utils/storage';

class ThemeStore {
  current = $state<'light' | 'dark'>('dark');

  /**
   * Dark is the default, unconditionally.
   *
   * A saved preference still wins — this only decides what a fresh install
   * opens with. The OS `prefers-color-scheme: light` check that used to sit
   * here meant most machines started in light despite dark being the designed
   * default.
   */
  constructor() {
    if (typeof window === 'undefined') return;
    const saved = loadTheme();
    if (saved) this.current = saved;
    this.apply();
  }

  toggle() {
    this.current = this.current === 'light' ? 'dark' : 'light';
    this.apply();
  }

  set(next: 'light' | 'dark') {
    this.current = next;
    this.apply();
  }

  private apply() {
    if (typeof document === 'undefined') return;
    document.documentElement.classList.toggle('dark', this.current === 'dark');
    saveTheme(this.current);
  }
}

export const themeStore = new ThemeStore();

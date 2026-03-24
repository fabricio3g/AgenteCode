import { loadTheme, saveTheme } from '$lib/utils/storage';

class ThemeStore {
  current = $state<'light' | 'dark'>('dark');

  constructor() {
    if (typeof window === 'undefined') return;
    const saved = loadTheme();
    if (saved) {
      this.current = saved;
    } else if (window.matchMedia('(prefers-color-scheme: light)').matches) {
      this.current = 'light';
    }
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

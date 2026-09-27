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

  toggle(origin?: { x: number; y: number }) {
    this.current = this.current === 'light' ? 'dark' : 'light';
    this.applyWithReveal(origin);
  }

  set(next: 'light' | 'dark') {
    this.current = next;
    this.applyWithReveal();
  }

  private apply() {
    if (typeof document === 'undefined') return;
    document.documentElement.classList.toggle('dark', this.current === 'dark');
    saveTheme(this.current);
  }

  /**
   * The theme flip is the one full-screen change a chat app makes, so it earns
   * the one full-screen animation: a circular reveal expanding from the toggle
   * (View Transitions API). Falls back to an instant swap where unsupported or
   * when reduced motion asks for quiet.
   */
  private applyWithReveal(origin?: { x: number; y: number }) {
    if (typeof document === 'undefined') {
      this.apply();
      return;
    }
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const supported = typeof document.startViewTransition === 'function' && !reduce;
    if (!supported) {
      this.apply();
      return;
    }

    const root = document.documentElement;
    if (origin) {
      const radius = Math.hypot(
        Math.max(origin.x, window.innerWidth - origin.x),
        Math.max(origin.y, window.innerHeight - origin.y)
      );
      root.style.setProperty('--vt-x', `${origin.x}px`);
      root.style.setProperty('--vt-y', `${origin.y}px`);
      root.style.setProperty('--vt-r', `${radius}px`);
    }
    document.startViewTransition(() => this.apply());
  }
}

export const themeStore = new ThemeStore();

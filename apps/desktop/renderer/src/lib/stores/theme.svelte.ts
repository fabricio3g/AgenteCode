import { loadTheme, saveTheme } from '$lib/utils/storage';
import { appWindow } from '$lib/services/window';
import { isElectron } from '$lib/services/bridge';
import { WINDOW_THEME_COLORS } from '$shared/window-theme';

class ThemeStore {
  current = $state<'light' | 'dark'>('dark');
  private resetFrame = 0;

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
    if (next === this.current) return;
    this.current = next;
    this.applyWithReveal();
  }

  private apply() {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (isElectron()) {
      root.dataset.themeSwitching = 'true';
      cancelAnimationFrame(this.resetFrame);
      this.resetFrame = requestAnimationFrame(() => {
        this.resetFrame = requestAnimationFrame(() => { delete root.dataset.themeSwitching; });
      });
    }
    root.classList.toggle('dark', this.current === 'dark');
    saveTheme(this.current);
    void appWindow.setTitlebarOverlay(WINDOW_THEME_COLORS[this.current]).catch(() => {});
  }

  /**
   * The theme flip is the one full-screen change a chat app makes, so it earns
   * the one full-screen animation: a circular reveal expanding from the toggle
   * (View Transitions API). Falls back to an instant swap where unsupported or
   * when reduced motion asks for quiet.
   */
  private applyWithReveal(origin?: { x: number; y: number }) {
    if (typeof document === 'undefined' || isElectron()) {
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
    // A skipped transition (rapid toggles, HMR, unload) rejects its promises:
    // handled here so it never surfaces as an unhandled rejection.
    const transition = document.startViewTransition(() => this.apply());
    transition.ready.catch(() => {});
    transition.finished.catch(() => {});
  }
}

export const themeStore = new ThemeStore();

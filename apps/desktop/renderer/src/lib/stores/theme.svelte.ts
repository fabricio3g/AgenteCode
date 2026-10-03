import { loadTheme, saveTheme } from '$lib/utils/storage';
import { appWindow } from '$lib/services/window';
import { TITLEBAR_OVERLAY_COLOR } from '$shared/titlebar';

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
    void this.syncCaptionOverlay();
  }

  /**
   * Hand the OS caption buttons the current surface colours.
   *
   * Caption buttons live outside the web contents. Transparent overlay colour
   * therefore becomes the platform's default grey instead of showing the
   * titlebar behind it. Read both colours from the live CSS tokens so the
   * native strip follows the UI on a theme flip.
   */
  private async syncCaptionOverlay() {
    const styles = getComputedStyle(document.documentElement);
    const symbolColor = styles.getPropertyValue('--foreground').trim();
    const background = styles.getPropertyValue('--background').trim();
    if (!symbolColor) return;
    // The current palettes use hex tokens, which Electron accepts on every
    // supported platform. Keep the shared dark default for an unusual custom
    // token rather than sending a value the main-process validator rejects.
    const color = /^#[\da-f]{3,8}$/i.test(background) ? background : TITLEBAR_OVERLAY_COLOR;
    await appWindow.setTitlebarOverlay({ color, symbolColor });
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

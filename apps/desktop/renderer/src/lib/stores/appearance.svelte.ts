import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  getAccentPreset,
  getTitlebarColors,
  hexToRgbTriplet,
  isIntegratedComposerStyle,
  normalizeHexColor,
  parseAppearance,
  resolveColorMode,
  type AppearancePrefs,
  type ColorMode,
  type ResolvedColorMode
} from '$shared/appearance';
import { appWindow } from '$lib/services/window';
import { isElectron } from '$lib/services/bridge';
import { loadTheme, saveTheme } from '$lib/utils/storage';

class AppearanceStore {
  prefs = $state<AppearancePrefs>({ ...DEFAULT_APPEARANCE });
  private systemPrefersDark = $state(true);
  private resetFrame = 0;

  resolvedMode = $derived<ResolvedColorMode>(resolveColorMode(this.prefs.mode, this.systemPrefersDark));
  integratedComposer = $derived(isIntegratedComposerStyle(this.prefs.composerStyle));

  constructor() {
    if (typeof window === 'undefined') return;
    const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    if (media) {
      this.systemPrefersDark = media.matches;
      const onChange = (event: MediaQueryListEvent) => {
        this.systemPrefersDark = event.matches;
        if (this.prefs.mode === 'system') this.apply();
      };
      media.addEventListener?.('change', onChange);
    }

    try {
      const legacy = loadTheme();
      this.prefs = parseAppearance(localStorage.getItem(APPEARANCE_STORAGE_KEY), legacy);
    } catch {
      this.prefs = { ...DEFAULT_APPEARANCE };
    }
    this.apply();
  }

  update(patch: Partial<AppearancePrefs>, options?: { revealOrigin?: { x: number; y: number } }) {
    const prevMode = this.resolvedMode;
    const next: AppearancePrefs = {
      ...this.prefs,
      ...patch,
      customAccentHex: normalizeHexColor(patch.customAccentHex ?? this.prefs.customAccentHex, DEFAULT_APPEARANCE.customAccentHex)
    };
    this.prefs = next;
    this.persist();

    const nextMode = resolveColorMode(next.mode, this.systemPrefersDark);
    if (options?.revealOrigin && nextMode !== prevMode) {
      this.applyWithReveal(options.revealOrigin);
    } else {
      this.apply();
    }
  }

  setMode(mode: ColorMode, origin?: { x: number; y: number }) {
    if (mode === this.prefs.mode) return;
    this.update({ mode }, { revealOrigin: origin });
  }

  toggleMode(origin?: { x: number; y: number }) {
    const next: ResolvedColorMode = this.resolvedMode === 'light' ? 'dark' : 'light';
    this.update({ mode: next }, { revealOrigin: origin });
  }

  reset() {
    this.update({ ...DEFAULT_APPEARANCE });
  }

  /** Re-applies current appearance tokens and titlebar overlay without altering saved mode. */
  sync() {
    this.apply();
  }

  private persist() {
    try {
      localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(this.prefs));
    } catch {
      /* private mode: applies for this session only */
    }
    saveTheme(this.resolvedMode);
  }

  private apply() {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const resolved = this.resolvedMode;
    const { theme, accent, customAccentHex, uiStyle, composerStyle, tintedUserBubbles } = this.prefs;

    if (isElectron()) {
      root.dataset.themeSwitching = 'true';
      cancelAnimationFrame(this.resetFrame);
      this.resetFrame = requestAnimationFrame(() => {
        this.resetFrame = requestAnimationFrame(() => {
          delete root.dataset.themeSwitching;
        });
      });
    }

    root.classList.toggle('dark', resolved === 'dark');
    root.dataset.theme = theme;
    root.dataset.accent = accent;
    root.dataset.uiStyle = uiStyle;
    root.dataset.composerStyle = composerStyle;
    root.classList.toggle('appearance-tinted-bubbles', tintedUserBubbles);

    if (accent === 'custom') {
      const safeHex = normalizeHexColor(customAccentHex);
      const rgb = hexToRgbTriplet(safeHex);
      root.style.setProperty('--brand-accent', safeHex);
      root.style.setProperty(
        '--brand-accent-strong',
        resolved === 'dark' ? `color-mix(in srgb, ${safeHex} 72%, #ffffff)` : `color-mix(in srgb, ${safeHex} 76%, #000000)`
      );
      root.style.setProperty('--tile-accent', rgb);
      root.style.setProperty('--tile-hi', resolved === 'dark' ? '255 255 255' : rgb);
      root.style.setProperty('--glow', `rgb(${rgb} / ${resolved === 'dark' ? '0.14' : '0.11'})`);
    } else {
      const preset = getAccentPreset(accent);
      const color = resolved === 'dark' ? preset.dark : preset.light;
      const strong = resolved === 'dark' ? preset.darkStrong : preset.lightStrong;
      const rgb = hexToRgbTriplet(color);
      root.style.setProperty('--brand-accent', color);
      root.style.setProperty('--brand-accent-strong', strong);
      if (accent === 'ember') {
        root.style.removeProperty('--tile-accent');
        root.style.removeProperty('--tile-hi');
        root.style.removeProperty('--glow');
      } else {
        root.style.setProperty('--tile-accent', rgb);
        root.style.setProperty('--tile-hi', hexToRgbTriplet(strong));
        root.style.setProperty('--glow', `rgb(${rgb} / ${resolved === 'dark' ? '0.13' : '0.10'})`);
      }
    }

    const titlebar = getTitlebarColors(theme, resolved);
    void appWindow.setTitlebarOverlay(titlebar).catch(() => {});
  }

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
    const transition = document.startViewTransition(() => this.apply());
    transition.ready.catch(() => {});
    transition.finished.catch(() => {});
  }
}

export const appearanceStore = new AppearanceStore();

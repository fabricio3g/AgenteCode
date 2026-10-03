// Settings → Accessibility: interface size, reading text, font, spacing,
// motion, contrast, focus and links. These belong to this computer (like the
// theme), so they live in localStorage and apply before the first paint.

import { setMotionPreference } from '$lib/utils/motion.svelte';
import { zoomKeyDirection } from '$shared/zoom-keys';

export type ReduceMotion = 'system' | 'on' | 'off';
export type ReadingFont = 'default' | 'system' | 'hyperlegible';
/**
 * Stroke weight for conversation text. Inter Variable carries the full 100–900
 * axis, so `medium` is a real interpolated weight — never a faux bold.
 */
export type TextWeight = 'regular' | 'medium';

export interface AccessibilityPrefs {
  /** Whole-interface zoom (text, controls and spacing together). */
  uiScale: number;
  /** Chat messages and the composer, on top of the interface size. */
  textScale: number;
  textWeight: TextWeight;
  font: ReadingFont;
  relaxedSpacing: boolean;
  reduceMotion: ReduceMotion;
  highContrast: boolean;
  focusRings: boolean;
  underlineLinks: boolean;
}

export const UI_SCALES = [0.8, 0.9, 1, 1.1, 1.25, 1.5] as const;
export const TEXT_SCALES = [0.9, 1, 1.15, 1.3, 1.5] as const;

export const DEFAULT_ACCESSIBILITY: AccessibilityPrefs = {
  uiScale: 1,
  textScale: 1,
  textWeight: 'regular',
  font: 'default',
  relaxedSpacing: false,
  reduceMotion: 'system',
  highContrast: false,
  focusRings: false,
  underlineLinks: false
};

const STORAGE_KEY = 'agente_accessibility';

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

/** Stored JSON → prefs, dropping anything unknown or out of range. */
export function parseAccessibility(raw: string | null): AccessibilityPrefs {
  let saved: Partial<AccessibilityPrefs> = {};
  try {
    saved = raw ? (JSON.parse(raw) as Partial<AccessibilityPrefs>) : {};
  } catch {
    saved = {};
  }
  const base = DEFAULT_ACCESSIBILITY;
  return {
    uiScale: clamp(saved.uiScale, 0.5, 2, base.uiScale),
    textScale: clamp(saved.textScale, 0.75, 2, base.textScale),
    textWeight: saved.textWeight === 'medium' ? 'medium' : 'regular',
    font: saved.font === 'system' || saved.font === 'hyperlegible' ? saved.font : 'default',
    relaxedSpacing: saved.relaxedSpacing === true,
    reduceMotion: saved.reduceMotion === 'on' || saved.reduceMotion === 'off' ? saved.reduceMotion : 'system',
    highContrast: saved.highContrast === true,
    focusRings: saved.focusRings === true,
    underlineLinks: saved.underlineLinks === true
  };
}

/** The next interface size up or down the presets (Ctrl + / Ctrl -). */
export function stepScale(current: number, direction: 1 | -1): number {
  if (direction > 0) return UI_SCALES.find((scale) => scale > current + 0.001) ?? UI_SCALES[UI_SCALES.length - 1];
  return [...UI_SCALES].reverse().find((scale) => scale < current - 0.001) ?? UI_SCALES[0];
}

let hyperlegibleLoaded = false;

class AccessibilityStore {
  prefs = $state<AccessibilityPrefs>({ ...DEFAULT_ACCESSIBILITY });

  constructor() {
    if (typeof window === 'undefined') return;
    try {
      this.prefs = parseAccessibility(localStorage.getItem(STORAGE_KEY));
    } catch {
      this.prefs = { ...DEFAULT_ACCESSIBILITY };
    }
    this.apply();
    // Ctrl/Cmd +, - and 0: main forwards them in Electron; the browser harness listens itself.
    if (window.electronAPI?.on) {
      window.electronAPI.on('ui-zoom', (direction) => this.zoom(Number(direction) as 1 | -1 | 0));
    } else {
      window.addEventListener('keydown', (event) => {
        const direction = zoomKeyDirection(event.key, event.ctrlKey || event.metaKey, event.altKey);
        if (direction === null) return;
        event.preventDefault();
        this.zoom(direction);
      });
    }
  }

  update(patch: Partial<AccessibilityPrefs>) {
    this.prefs = { ...this.prefs, ...patch };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.prefs));
    } catch {
      /* private mode: applies for this session only */
    }
    this.apply();
  }

  reset() {
    this.update({ ...DEFAULT_ACCESSIBILITY });
  }

  zoom(direction: 1 | -1 | 0) {
    this.update({ uiScale: direction === 0 ? 1 : stepScale(this.prefs.uiScale, direction) });
  }

  private apply() {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const { prefs } = this;

    if (window.electronAPI?.setZoomFactor) {
      window.electronAPI.setZoomFactor(prefs.uiScale);
      root.style.removeProperty('zoom');
    } else {
      // Browser (dev harness): CSS zoom gives the same result.
      if (prefs.uiScale === 1) root.style.removeProperty('zoom');
      else root.style.setProperty('zoom', String(prefs.uiScale));
    }

    root.style.setProperty('--reading-scale', String(prefs.textScale));
    root.style.setProperty('--reading-weight', prefs.textWeight === 'medium' ? '500' : '400');
    if (prefs.font === 'hyperlegible' && !hyperlegibleLoaded) {
      hyperlegibleLoaded = true;
      void import('@fontsource/atkinson-hyperlegible/400.css');
      void import('@fontsource/atkinson-hyperlegible/700.css');
    }
    root.dataset.font = prefs.font;
    root.classList.toggle('a11y-relaxed', prefs.relaxedSpacing);
    setMotionPreference(prefs.reduceMotion);
    root.classList.toggle('a11y-reduce-motion', prefs.reduceMotion === 'on');
    root.classList.toggle('a11y-allow-motion', prefs.reduceMotion === 'off');
    root.classList.toggle('a11y-contrast', prefs.highContrast);
    root.classList.toggle('a11y-focus', prefs.focusRings);
    root.classList.toggle('a11y-underline', prefs.underlineLinks);
  }
}

export const accessibilityStore = new AccessibilityStore();

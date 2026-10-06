// Keep the OS caption buttons under a dialog's backdrop.
//
// On Windows and Linux the minimize/maximize/close buttons are drawn by the
// OS on a solid patch (`titleBarOverlay`), outside the web contents. A modal
// backdrop dims the page but cannot reach that patch, so the buttons used to
// sit in a bright box above a darkened window. While a dimming layer is open
// the patch is repainted with the colour the backdrop would have produced.

import { WINDOW_THEME_COLORS } from '$shared/window-theme';
import { appWindow } from './window';

function rgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? [...value].map((c) => c + c).join('') : value.slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

function hex([r, g, b]: number[]): string {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

/** The backdrop colour (`--overlay`) as rgb + alpha. */
function overlay(): { color: [number, number, number]; alpha: number } {
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;background:var(--overlay)';
  document.body.appendChild(probe);
  const parsed = getComputedStyle(probe).backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0.5];
  probe.remove();
  const [r = 0, g = 0, b = 0, a = 1] = parsed;
  return { color: [r, g, b], alpha: a };
}

function blend(base: string, top: { color: number[]; alpha: number }): string {
  return hex(rgb(base).map((c, i) => c * (1 - top.alpha) + top.color[i]! * top.alpha));
}

export function dimCaption(dimmed: boolean): void {
  if (typeof document === 'undefined') return;
  const theme = WINDOW_THEME_COLORS[document.documentElement.classList.contains('dark') ? 'dark' : 'light'];
  if (!dimmed) {
    void appWindow.setTitlebarOverlay(theme).catch(() => {});
    return;
  }
  const top = overlay();
  void appWindow
    .setTitlebarOverlay({ color: blend(theme.color, top), symbolColor: blend(theme.symbolColor, top) })
    .catch(() => {});
}

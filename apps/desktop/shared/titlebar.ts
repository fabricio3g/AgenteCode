/**
 * Window chrome shared between the main process and the renderer.
 *
 * Lives in `shared/` because both sides have to agree on it: main sizes and
 * creates the overlay, the renderer recolours it when the theme flips.
 */

/**
 * Height of the renderer-drawn titlebar (Titlebar.svelte is `h-9`). The
 * Windows/Linux caption overlay is sized to match so the OS buttons share our
 * row instead of sitting in a strip of their own.
 */
export const TITLEBAR_HEIGHT = 36;

/**
 * Default overlay fill, matching the dark theme's `--background`.
 *
 * The OS caption buttons are outside the web contents, so a transparent
 * Electron overlay falls back to the platform's own grey on Linux/Windows.
 * That makes a hard rectangle at the top-right. The renderer pushes the live
 * theme background after first paint; this dark value keeps the first frame
 * coherent before that update arrives.
 */
export const TITLEBAR_OVERLAY_COLOR = '#161616';

/**
 * Default symbol (glyph) colour, matching the dark theme's `--foreground`.
 * The renderer pushes both the live fill and glyph colour through
 * `window:set-titlebar-overlay` on every theme change.
 */
export const TITLEBAR_SYMBOL_COLOR = '#ececec';
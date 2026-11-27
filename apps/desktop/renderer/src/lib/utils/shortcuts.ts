/**
 * Keyboard shortcut labels that match the platform: `mod+shift+k` reads
 * "⌘⇧K" on macOS and "Ctrl+Shift+K" elsewhere. One place, so a hint can never
 * again show ⌘K for a Ctrl+Shift+K binding.
 */

export function isMacPlatform(): boolean {
  const platform = globalThis.window?.electronAPI?.platform ?? globalThis.navigator?.platform ?? '';
  return platform === 'darwin' || /mac/i.test(platform);
}

const MAC_KEYS: Record<string, string> = { mod: '⌘', shift: '⇧', alt: '⌥', ctrl: '⌃', enter: '↩', escape: 'Esc', left: '←', right: '→' };
const PC_KEYS: Record<string, string> = { mod: 'Ctrl', shift: 'Shift', alt: 'Alt', ctrl: 'Ctrl', enter: 'Enter', escape: 'Esc', left: '←', right: '→' };

/** The keys of a combo, one cap each: `mod+shift+k` → ["⌘","⇧","K"] / ["Ctrl","Shift","K"]. */
export function shortcutKeys(combo: string, mac = isMacPlatform()): string[] {
  const names = mac ? MAC_KEYS : PC_KEYS;
  return combo.split('+').map((part) => names[part.toLowerCase()] ?? (part.length === 1 ? part.toUpperCase() : part));
}

export function formatShortcut(combo: string, mac = isMacPlatform()): string {
  const names = mac ? MAC_KEYS : PC_KEYS;
  const parts = combo.split('+').map((part) => names[part.toLowerCase()] ?? (part.length === 1 ? part.toUpperCase() : part));
  return parts.join(mac ? '' : '+');
}

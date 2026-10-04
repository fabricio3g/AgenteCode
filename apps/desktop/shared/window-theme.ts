export type WindowTheme = 'light' | 'dark';
export const THEME_STORAGE_KEY = 'chatealm_theme';
export const WINDOW_THEME_COLORS = {
  light: { color: '#ffffff', symbolColor: '#0d0d0d' },
  dark: { color: '#161616', symbolColor: '#ececec' }
} as const;

export function parseWindowTheme(value: unknown): WindowTheme | null {
  return value === 'light' || value === 'dark' ? value : null;
}

/** Shared startup CSS: available before fonts, application CSS or modules load. */
export function windowThemeCss(): string {
  return Object.entries(WINDOW_THEME_COLORS).map(([theme, colors]) =>
    `${theme === 'dark' ? ':root.dark' : ':root'}{--theme-background:${colors.color};--theme-foreground:${colors.symbolColor};color-scheme:${theme};background:var(--theme-background)}`
  ).join('') + 'body{margin:0;background:var(--theme-background);color:var(--theme-foreground)}';
}

/** Vite inserts this as a blocking head script in both dev and packaged HTML. */
export function windowThemeBootstrap(): string {
  return `(()=>{let theme='dark';try{if(localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})==='light')theme='light'}catch{}document.documentElement.classList.toggle('dark',theme==='dark');const colors=${JSON.stringify(WINDOW_THEME_COLORS)}[theme];Promise.resolve(window.electronAPI?.windowSetTitlebarOverlay?.(colors)).catch(()=>{});})();`;
}

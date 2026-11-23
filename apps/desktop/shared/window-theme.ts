import { APPEARANCE_STORAGE_KEY, THEME_PRESETS } from './appearance';

export type WindowTheme = 'light' | 'dark';
export const THEME_STORAGE_KEY = 'chatealm_theme';
export const WINDOW_THEME_COLORS = {
  light: { color: '#ffffff', symbolColor: '#000000' },
  dark: { color: '#1c1c1c', symbolColor: '#ffffff' }
} as const;

export function parseWindowTheme(value: unknown): WindowTheme | null {
  return value === 'light' || value === 'dark' ? value : null;
}

/** Shared startup CSS: available before fonts, application CSS or modules load. */
export function windowThemeCss(): string {
  const baseRules = Object.entries(WINDOW_THEME_COLORS).map(([theme, colors]) =>
    `${theme === 'dark' ? ':root.dark' : ':root'}{--theme-background:${colors.color};--theme-foreground:${colors.symbolColor};color-scheme:${theme};background:var(--theme-background)}`
  );
  const presetRules = THEME_PRESETS.filter((preset) => preset.id !== 'agente').flatMap((preset) => [
    `:root[data-theme="${preset.id}"]{--theme-background:${preset.light.background};--theme-foreground:${preset.light.foreground}}`,
    `:root.dark[data-theme="${preset.id}"]{--theme-background:${preset.dark.background};--theme-foreground:${preset.dark.foreground}}`
  ]);
  return [...baseRules, ...presetRules].join('') + 'body{margin:0;background:var(--theme-background);color:var(--theme-foreground)}';
}

/** Vite inserts this as a blocking head script in both dev and packaged HTML. */
export function windowThemeBootstrap(): string {
  const presetMap = Object.fromEntries(
    THEME_PRESETS.map((preset) => [
      preset.id,
      {
        light: { color: preset.light.background, symbolColor: preset.light.foreground },
        dark: { color: preset.dark.background, symbolColor: preset.dark.foreground }
      }
    ])
  );
  return `(()=>{let mode='dark',theme='agente',uiStyle='default',composerStyle='agente',accent='ember';try{const raw=localStorage.getItem(${JSON.stringify(APPEARANCE_STORAGE_KEY)});if(raw){const p=JSON.parse(raw);if(p&&typeof p==='object'){if(p.mode==='light'||p.mode==='dark'||p.mode==='system')mode=p.mode;if(typeof p.theme==='string')theme=p.theme;if(typeof p.uiStyle==='string')uiStyle=p.uiStyle;if(typeof p.composerStyle==='string')composerStyle=p.composerStyle;if(typeof p.accent==='string')accent=p.accent;}}else if(localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})==='light'){mode='light';}}catch{}const prefersDark=typeof window.matchMedia==='function'?window.matchMedia('(prefers-color-scheme: dark)').matches:true;const resolved=mode==='system'?(prefersDark?'dark':'light'):mode;const root=document.documentElement;root.classList.toggle('dark',resolved==='dark');root.dataset.theme=theme;root.dataset.uiStyle=uiStyle;root.dataset.composerStyle=composerStyle;root.dataset.accent=accent;const presets=${JSON.stringify(presetMap)};const colors=(presets[theme]||presets.agente)[resolved];Promise.resolve(window.electronAPI?.windowSetTitlebarOverlay?.(colors)).catch(()=>{});})();`;
}

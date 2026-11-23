export type ColorMode = 'system' | 'light' | 'dark';
export type ResolvedColorMode = 'light' | 'dark';

export type ThemePresetId = 'agente' | 'parchment' | 'midnight' | 'slate' | 'sepia';
export type AccentPresetId =
  | 'ember'
  | 'terracotta'
  | 'emerald'
  | 'cobalt'
  | 'violet'
  | 'rose'
  | 'monochrome'
  | 'custom';
export type UiStyleId = 'default' | 'soft' | 'sharp' | 'minimal';
export type ComposerStyleId = 'agente' | 'pill' | 'card' | 'terminal' | 'minimal';

export interface AppearancePrefs {
  mode: ColorMode;
  theme: ThemePresetId;
  accent: AccentPresetId;
  customAccentHex: string;
  uiStyle: UiStyleId;
  composerStyle: ComposerStyleId;
  tintedUserBubbles: boolean;
}

export const APPEARANCE_STORAGE_KEY = 'agente_appearance';

export const DEFAULT_APPEARANCE: AppearancePrefs = {
  mode: 'dark',
  theme: 'agente',
  accent: 'ember',
  customAccentHex: '#e8793a',
  uiStyle: 'default',
  composerStyle: 'agente',
  tintedUserBubbles: false
};

export interface ThemeSurfacePalette {
  background: string;
  foreground: string;
  sidebar: string;
  card: string;
  accentSwatch: string;
}

export interface ThemePresetMeta {
  id: ThemePresetId;
  light: ThemeSurfacePalette;
  dark: ThemeSurfacePalette;
}

export const THEME_PRESETS: readonly ThemePresetMeta[] = [
  {
    id: 'agente',
    light: { background: '#ffffff', foreground: '#000000', sidebar: '#ffffff', card: '#fafafa', accentSwatch: '#e76d1f' },
    dark: { background: '#1c1c1c', foreground: '#ffffff', sidebar: '#212121', card: '#232323', accentSwatch: '#e8793a' }
  },
  {
    id: 'parchment',
    light: { background: '#f6f4ef', foreground: '#1f1d1a', sidebar: '#efece5', card: '#fcfbf8', accentSwatch: '#d97757' },
    dark: { background: '#1f1d1a', foreground: '#f4f0e8', sidebar: '#26231f', card: '#2a2622', accentSwatch: '#de8363' }
  },
  {
    id: 'midnight',
    light: { background: '#f8f9fb', foreground: '#0f1218', sidebar: '#f1f3f7', card: '#ffffff', accentSwatch: '#3b82f6' },
    dark: { background: '#0f1012', foreground: '#f3f4f6', sidebar: '#14161a', card: '#17191e', accentSwatch: '#60a5fa' }
  },
  {
    id: 'slate',
    light: { background: '#f2f5f8', foreground: '#121821', sidebar: '#e9eef4', card: '#fafbfd', accentSwatch: '#2563eb' },
    dark: { background: '#181c23', foreground: '#eef2f7', sidebar: '#1d222b', card: '#212731', accentSwatch: '#5897f5' }
  },
  {
    id: 'sepia',
    light: { background: '#f4efe4', foreground: '#26221b', sidebar: '#ece6d8', card: '#faf6ec', accentSwatch: '#b86b2b' },
    dark: { background: '#1d1e19', foreground: '#efeae0', sidebar: '#23241e', card: '#272821', accentSwatch: '#d49048' }
  }
] as const;

export interface AccentPresetMeta {
  id: Exclude<AccentPresetId, 'custom'>;
  light: string;
  lightStrong: string;
  dark: string;
  darkStrong: string;
  swatch: string;
}

export const ACCENT_PRESETS: readonly AccentPresetMeta[] = [
  { id: 'ember', light: '#e76d1f', lightStrong: '#b34a0e', dark: '#e8793a', darkStrong: '#f29a64', swatch: '#e8793a' },
  { id: 'terracotta', light: '#c96442', lightStrong: '#9a4326', dark: '#d97757', darkStrong: '#eba087', swatch: '#d97757' },
  { id: 'emerald', light: '#1f8a62', lightStrong: '#146245', dark: '#38b283', darkStrong: '#72d1ab', swatch: '#2f9e73' },
  { id: 'cobalt', light: '#2563eb', lightStrong: '#1d4ed8', dark: '#548ef7', darkStrong: '#8ab4fa', swatch: '#3b82f6' },
  { id: 'violet', light: '#7c3aed', lightStrong: '#5b21b6', dark: '#9d74f7', darkStrong: '#c0a6fb', swatch: '#8b5cf6' },
  { id: 'rose', light: '#cf4868', lightStrong: '#9f2a47', dark: '#e46b88', darkStrong: '#f29cb0', swatch: '#e05d7b' },
  { id: 'monochrome', light: '#262626', lightStrong: '#000000', dark: '#d4d4d4', darkStrong: '#ffffff', swatch: '#737373' }
] as const;

export const UI_STYLE_IDS: readonly UiStyleId[] = ['default', 'soft', 'sharp', 'minimal'] as const;
export const COMPOSER_STYLE_IDS: readonly ComposerStyleId[] = ['agente', 'pill', 'card', 'terminal', 'minimal'] as const;

const THEME_ID_SET = new Set<string>(THEME_PRESETS.map((preset) => preset.id));
const ACCENT_ID_SET = new Set<string>([...ACCENT_PRESETS.map((preset) => preset.id), 'custom']);
const UI_STYLE_SET = new Set<string>(UI_STYLE_IDS);
const COMPOSER_STYLE_SET = new Set<string>(COMPOSER_STYLE_IDS);

export function normalizeHexColor(value: unknown, fallback = DEFAULT_APPEARANCE.customAccentHex): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const [, r, g, b] = trimmed;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return fallback;
}

export function hexToRgbTriplet(hex: string): string {
  const safe = normalizeHexColor(hex);
  const r = parseInt(safe.slice(1, 3), 16);
  const g = parseInt(safe.slice(3, 5), 16);
  const b = parseInt(safe.slice(5, 7), 16);
  return `${r} ${g} ${b}`;
}

export function parseAppearance(raw: string | null, legacyTheme?: 'light' | 'dark' | null): AppearancePrefs {
  let saved: Partial<AppearancePrefs> = {};
  try {
    saved = raw ? (JSON.parse(raw) as Partial<AppearancePrefs>) : {};
  } catch {
    saved = {};
  }

  const base = DEFAULT_APPEARANCE;
  const mode: ColorMode =
    saved.mode === 'system' || saved.mode === 'light' || saved.mode === 'dark'
      ? saved.mode
      : legacyTheme === 'light' || legacyTheme === 'dark'
        ? legacyTheme
        : base.mode;

  return {
    mode,
    theme: typeof saved.theme === 'string' && THEME_ID_SET.has(saved.theme) ? (saved.theme as ThemePresetId) : base.theme,
    accent: typeof saved.accent === 'string' && ACCENT_ID_SET.has(saved.accent) ? (saved.accent as AccentPresetId) : base.accent,
    customAccentHex: normalizeHexColor(saved.customAccentHex, base.customAccentHex),
    uiStyle: typeof saved.uiStyle === 'string' && UI_STYLE_SET.has(saved.uiStyle) ? (saved.uiStyle as UiStyleId) : base.uiStyle,
    composerStyle:
      typeof saved.composerStyle === 'string' && COMPOSER_STYLE_SET.has(saved.composerStyle)
        ? (saved.composerStyle as ComposerStyleId)
        : base.composerStyle,
    tintedUserBubbles: saved.tintedUserBubbles === true
  };
}

export function resolveColorMode(mode: ColorMode, prefersDark: boolean): ResolvedColorMode {
  if (mode === 'system') return prefersDark ? 'dark' : 'light';
  return mode;
}

export function getThemePreset(id: ThemePresetId): ThemePresetMeta {
  return THEME_PRESETS.find((preset) => preset.id === id) ?? THEME_PRESETS[0];
}

export function getTitlebarColors(theme: ThemePresetId, resolvedMode: ResolvedColorMode): { color: string; symbolColor: string } {
  const palette = getThemePreset(theme)[resolvedMode];
  return { color: palette.background, symbolColor: palette.foreground };
}

export function getAccentPreset(id: Exclude<AccentPresetId, 'custom'>): AccentPresetMeta {
  return ACCENT_PRESETS.find((preset) => preset.id === id) ?? ACCENT_PRESETS[0];
}

/** True when a composer style keeps the toolbar inside the prompt shell rather than docked below it. */
export function isIntegratedComposerStyle(style: ComposerStyleId): boolean {
  return style === 'pill' || style === 'card' || style === 'terminal' || style === 'minimal';
}

export type DriverIconId =
  | 'agente'
  | 'claude'
  | 'codex'
  | 'opencode'
  | 'pi'
  | 'copilot'
  | 'gemini'
  | 'qwen'
  | 'cursor'
  | 'goose'
  | 'cline'
  | 'kilo'
  | 'kimi'
  | 'auggie'
  | 'kiro'
  | 'droid'
  | 'vibe'
  | 'amp'
  | 'grok'
  | 'junie'
  | 'devin'
  | 'qoder'
  | 'generic';

const KNOWN_DRIVER_ICONS = new Set<DriverIconId>([
  'agente',
  'claude',
  'codex',
  'opencode',
  'pi',
  'copilot',
  'gemini',
  'qwen',
  'cursor',
  'goose',
  'cline',
  'kilo',
  'kimi',
  'auggie',
  'kiro',
  'droid',
  'vibe',
  'amp',
  'grok',
  'junie',
  'devin',
  'qoder'
]);

function kindFallback(driverKind?: string | null): DriverIconId | null {
  const kind = (driverKind ?? '').trim().toLowerCase();
  if (kind === 'claude' || kind === 'codex' || kind === 'opencode' || kind === 'pi' || kind === 'agente') {
    return kind;
  }
  return null;
}

/**
 * Resolves a coding driver `instance_id` / `driver_kind` pair to its icon key.
 * Custom `extends` profiles (e.g. `claude-work`, `codex_team`, `codex-acp`) inherit
 * their parent CLI's brand icon before falling back to `driver_kind`.
 */
export function resolveDriverIcon(instanceId?: string | null, driverKind?: string | null): DriverIconId {
  const id = (instanceId ?? '').trim().toLowerCase();
  if (!id || id === 'agente') {
    const fallback = kindFallback(driverKind);
    if (fallback) return fallback;
    return id === 'agente' ? 'agente' : 'generic';
  }

  if (KNOWN_DRIVER_ICONS.has(id as DriverIconId)) {
    return id as DriverIconId;
  }

  const prefix = id.split(/[-_.: /]/, 1)[0];
  if (prefix && KNOWN_DRIVER_ICONS.has(prefix as DriverIconId)) {
    return prefix as DriverIconId;
  }

  return kindFallback(driverKind) ?? 'generic';
}

/**
 * The CLIs whose own mark ships in `public/drivers/<id>.svg` (LobeHub icons,
 * MIT, monochrome): drawn as a mask in the text colour, so they sit in the
 * interface like any other glyph. Every other engine falls back to its letter mark.
 */
const DRIVER_LOGOS = new Set<DriverIconId>([
  'claude', 'codex', 'copilot', 'cursor', 'cline', 'opencode', 'gemini', 'qwen', 'goose',
  'kilo', 'kimi', 'kiro', 'vibe', 'amp', 'grok', 'junie', 'devin', 'qoder'
]);

/** The shipped logo for an engine, when there is one. */
export function driverLogo(kind: DriverIconId): string | null {
  return DRIVER_LOGOS.has(kind) ? `./drivers/${kind}.svg` : null;
}

/**
 * An external CLI without a shipped logo is drawn as a letter mark — its initial on a soft tile —
 * rather than an imitation of its product logo. The hue tells apart the
 * engines that share an initial (Claude, Codex, Copilot, Cursor and Cline are
 * all "C"); custom profiles inherit their parent's mark through
 * `resolveDriverIcon`. Agente Core keeps the app's own mark.
 */
const DRIVER_MARKS: Record<Exclude<DriverIconId, 'agente' | 'generic'>, { letter: string; hue: number }> = {
  claude: { letter: 'C', hue: 35 },
  codex: { letter: 'C', hue: 170 },
  copilot: { letter: 'C', hue: 255 },
  cursor: { letter: 'C', hue: 300 },
  cline: { letter: 'C', hue: 215 },
  opencode: { letter: 'O', hue: 95 },
  pi: { letter: 'P', hue: 330 },
  gemini: { letter: 'G', hue: 240 },
  goose: { letter: 'G', hue: 130 },
  grok: { letter: 'G', hue: 285 },
  qwen: { letter: 'Q', hue: 275 },
  qoder: { letter: 'Q', hue: 150 },
  kilo: { letter: 'K', hue: 60 },
  kimi: { letter: 'K', hue: 190 },
  kiro: { letter: 'K', hue: 320 },
  auggie: { letter: 'A', hue: 140 },
  amp: { letter: 'A', hue: 15 },
  droid: { letter: 'D', hue: 105 },
  devin: { letter: 'D', hue: 225 },
  vibe: { letter: 'V', hue: 350 },
  junie: { letter: 'J', hue: 120 }
};

/** The letter and hue an engine's mark wears; an unknown CLI takes its name's initial and a hue from it. */
export function driverMark(kind: DriverIconId, name?: string | null): { letter: string; hue: number } {
  if (kind !== 'agente' && kind !== 'generic') return DRIVER_MARKS[kind];
  const text = (name ?? '').trim();
  const letter = (text.match(/[\p{L}\p{N}]/u)?.[0] ?? '›').toUpperCase();
  let hash = 0;
  for (const char of text.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return { letter, hue: hash % 360 };
}

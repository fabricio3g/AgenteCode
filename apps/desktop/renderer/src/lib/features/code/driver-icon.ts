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

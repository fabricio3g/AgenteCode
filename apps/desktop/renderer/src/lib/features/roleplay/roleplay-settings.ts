import type { RoleplaySettings, WorldSettings } from '$lib/types/chat';

export const DECISION_DIRECTIONS = {
  reaction: 'a character responds through a small, revealing reaction',
  connection: 'a relationship develops through cooperation or disagreement',
  discovery: 'a relevant detail creates an opportunity to investigate',
  opportunity: 'an unfinished goal presents a plausible next step',
  pressure: 'an existing difficulty becomes more immediate',
  quiet: 'let the current conversation breathe without adding a new event'
} as const;

const CHAT: RoleplaySettings = {
  interactionMode: 'chat', replyStyle: 'dialogue', replyLength: 'adaptive',
  initiative: 'balanced', pacing: 'balanced', npcDialogue: true, maxExchangeLines: 3,
  surprise: 15, twistCooldown: 3, choiceMin: 2, choiceMax: 4,
  decisionWeights: { reaction: 3, connection: 2, discovery: 1, opportunity: 1, pressure: 1, quiet: 3 },
  outcomeRolls: false, outcomeWeights: { success: 5, cost: 3, setback: 2 }, showOutcomes: true,
  memoryEnabled: true, autoMemory: true, memoryBudget: 800,
  autocomplete: 'mention', nameInsertion: 'name', choiceExpiry: 'pause',
  genre: '', stakes: 'balanced', rerollEnabled: true, sceneNpcs: false,
  showAvatars: true, messageDensity: 'comfortable', actionFormatting: 'emphasis', voicePlayback: true,
  replyOrder: 'natural', autoMode: false, autoModeMaxTurns: 4, autoModeDelayMs: 8000,
  adventureChoices: false, choiceTimerSeconds: null, props: false, showSpeakerLabels: false,
  temperature: null, topP: null, maxTokens: null, authorNote: '', contentRating: 'sfw'
};

export const ROLEPLAY_PRESETS: Array<{ id: string; name: string; settings: RoleplaySettings }> = [
  { id: 'chat', name: 'Character chat', settings: CHAT },
  { id: 'narrative', name: 'Narrative scene', settings: { ...CHAT, interactionMode: 'narrative', replyStyle: 'narrative', surprise: 0 } },
  { id: 'dynamic', name: 'Dynamic scene', settings: { ...CHAT, interactionMode: 'dynamic', replyStyle: 'balanced', surprise: 45, props: true } },
  { id: 'cozy', name: 'Cozy conversation', settings: { ...CHAT, pacing: 'slow', surprise: 10, initiative: 'reactive' } },
  { id: 'mystery', name: 'Slow mystery', settings: { ...CHAT, interactionMode: 'dynamic', replyStyle: 'balanced', pacing: 'slow', surprise: 40, props: true, decisionWeights: { reaction: 2, connection: 1, discovery: 5, opportunity: 2, pressure: 1, quiet: 2 } } },
  { id: 'adventure', name: 'High-stakes adventure', settings: { ...CHAT, interactionMode: 'dynamic', replyStyle: 'balanced', initiative: 'proactive', pacing: 'fast', stakes: 'high', surprise: 65, outcomeRolls: true, props: true } }
];

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback;
}

/** One inheritance path for the editor, requests and new sessions. */
export function resolveRoleplaySettings(...layers: Array<Partial<RoleplaySettings & WorldSettings> | null | undefined>): RoleplaySettings {
  const merged = Object.assign({}, CHAT, ...layers.filter(Boolean)) as RoleplaySettings;
  merged.decisionWeights = Object.assign({}, CHAT.decisionWeights, ...layers.map((layer) => layer?.decisionWeights));
  merged.outcomeWeights = Object.assign({}, CHAT.outcomeWeights, ...layers.map((layer) => layer?.outcomeWeights));
  // Sessions written before modes keep their established prose/ensemble behavior.
  if (!layers.some((layer) => layer?.interactionMode) && layers.some((layer) => layer?.allowMultiSpeaker || layer?.adventureChoices)) {
    merged.interactionMode = 'dynamic';
    merged.replyStyle = 'balanced';
  }
  if (!['chat', 'narrative', 'dynamic'].includes(merged.interactionMode ?? '')) merged.interactionMode = 'chat';
  const enums = {
    replyStyle: ['dialogue', 'balanced', 'narrative'], replyLength: ['brief', 'adaptive', 'detailed'],
    initiative: ['reactive', 'balanced', 'proactive'], pacing: ['slow', 'balanced', 'fast'],
    autocomplete: ['off', 'mention', 'automatic'], nameInsertion: ['name', 'nickname'],
    choiceExpiry: ['pause', 'silence', 'event'], replyOrder: ['list', 'natural', 'mention', 'manual'],
    contentRating: ['sfw', 'unrestricted'], stakes: ['gentle', 'balanced', 'high'],
    messageDensity: ['comfortable', 'compact'], actionFormatting: ['emphasis', 'plain']
  };
  for (const [key, values] of Object.entries(enums)) {
    const field = key as keyof typeof enums;
    if (!values.includes(String(merged[field]))) Object.assign(merged, { [field]: CHAT[field] });
  }
  const dialogueLayer = [...layers].reverse().find((layer) => layer && (typeof layer.npcDialogue === 'boolean' || typeof layer.allowMultiSpeaker === 'boolean'));
  if (dialogueLayer && dialogueLayer.npcDialogue == null) merged.npcDialogue = dialogueLayer.allowMultiSpeaker;
  for (const key of ['npcDialogue', 'outcomeRolls', 'showOutcomes', 'memoryEnabled', 'autoMemory', 'autoMode', 'adventureChoices', 'props', 'showSpeakerLabels', 'rerollEnabled', 'sceneNpcs', 'showAvatars', 'voicePlayback'] as const) {
    if (typeof merged[key] !== 'boolean') Object.assign(merged, { [key]: CHAT[key] });
  }
  merged.surprise = bounded(merged.surprise, 15, 0, 100);
  merged.twistCooldown = bounded(merged.twistCooldown, 3, 0, 20);
  merged.maxExchangeLines = bounded(merged.maxExchangeLines, 3, 1, 8);
  merged.choiceMin = bounded(merged.choiceMin, 2, 1, 6);
  merged.choiceMax = bounded(merged.choiceMax, 4, merged.choiceMin, 6);
  merged.memoryBudget = bounded(merged.memoryBudget, 800, 100, 4000);
  merged.autoModeMaxTurns = bounded(merged.autoModeMaxTurns, 4, 1, 12);
  merged.autoModeDelayMs = bounded(merged.autoModeDelayMs, 8000, 1000, 20000);
  merged.choiceTimerSeconds = merged.choiceTimerSeconds == null ? null : bounded(merged.choiceTimerSeconds, 0, 0, 600);
  for (const [key, max] of [['temperature', 2], ['topP', 1], ['maxTokens', 32000]] as const) {
    const value = merged[key];
    merged[key] = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(max, value) : null;
  }
  for (const key of ['genre', 'authorNote'] as const) merged[key] = typeof merged[key] === 'string' ? merged[key].slice(0, 12000) : '';
  merged.decisionWeights = Object.fromEntries(Object.keys(DECISION_DIRECTIONS).map((key) => [key, bounded(merged.decisionWeights?.[key], CHAT.decisionWeights![key], 0, 100)]));
  merged.outcomeWeights = Object.fromEntries(['success', 'cost', 'setback'].map((key) => [key, bounded(merged.outcomeWeights?.[key as keyof NonNullable<RoleplaySettings['outcomeWeights']>], CHAT.outcomeWeights![key as keyof NonNullable<RoleplaySettings['outcomeWeights']>], 0, 100)])) as RoleplaySettings['outcomeWeights'];
  return merged;
}

/** Presets carry options, never a room, journal or another session's cast. */
export function presetSettings(settings: RoleplaySettings): RoleplaySettings {
  const resolved = resolveRoleplaySettings(settings);
  return Object.fromEntries(Object.keys(CHAT).map((key) => [key, resolved[key as keyof RoleplaySettings]])) as RoleplaySettings;
}

export function ensembleEnabled(settings: RoleplaySettings): boolean {
  return settings.npcDialogue ?? settings.allowMultiSpeaker ?? true;
}

const OPTION_KEYS = Object.keys(CHAT) as Array<keyof RoleplaySettings>;

/**
 * What a scene stores of its options: only the ones that differ from what it
 * inherits (your defaults, then the world's), so later changes to those still
 * reach it.
 */
export function sceneOverrides(options: Partial<RoleplaySettings>, inherited: RoleplaySettings): Partial<RoleplaySettings> {
  return Object.fromEntries(OPTION_KEYS
    .filter((key) => key in options && JSON.stringify(options[key]) !== JSON.stringify(inherited[key]))
    .map((key) => [key, options[key]])) as Partial<RoleplaySettings>;
}

/** The scene's own state in `chat.roleplay` (cast, room, journal…), without its options. */
export function sceneState(roleplay: Partial<RoleplaySettings> | null | undefined): Partial<RoleplaySettings> {
  return Object.fromEntries(Object.entries(roleplay ?? {}).filter(([key]) => !OPTION_KEYS.includes(key as keyof RoleplaySettings))) as Partial<RoleplaySettings>;
}

/**
 * Scenes created before options were stored as overrides held every option,
 * resolved at creation. Keep only the ones that differ from the built-in
 * defaults so the scene follows your defaults again.
 */
export function compactStoredScene(roleplay: RoleplaySettings | null | undefined): RoleplaySettings | null {
  if (!roleplay) return null;
  if (!OPTION_KEYS.every((key) => key in roleplay)) return roleplay;
  return { ...sceneState(roleplay), ...sceneOverrides(roleplay, CHAT) } as RoleplaySettings;
}

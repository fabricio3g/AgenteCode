import type { CharacterBook, CharacterCard, LorebookEntry, PromptTrim, RoleplaySettings, RoleplayTrimNote, RoleplayUsed, UserPersona, WorldSettings } from '$lib/types/chat';

export type { PromptTrim, RoleplayTrimNote, RoleplayUsed };
import { resolveMacros, type MacroContext } from './roleplay-macros';

/**
 * Roleplay prompt composition, split for the prefix cache.
 *
 * The stable block opens the request and is byte-identical across the turns of
 * a chat (and across speakers in a group):
 *   main instructions → content frame → world canon → every cast definition
 *   (roster order) → scenario → persona → example dialogue → post-history →
 *   mode policy.
 *
 * The volatile tail follows the history, just before the reply:
 *   active lore (by id) → scene NPCs → memory → room → author's note → group
 *   turn (roster, speaker) → choices → props.
 *   The turn adds its steering and twist lines and the speaker nudge after it.
 *
 * Nothing from the assistant stack (Flaxeo style prompt, chart hint, agent
 * guidance) is included: those fight roleplay and are never sent here.
 */

export interface MacroNames {
  char: string;
  user: string;
}

/**
 * Resolve the macros in card text for one pair of names. The full resolver
 * (services/roleplay-macros) takes time, seed and group context; this keeps
 * the old name-only call working.
 */
export function substituteMacros(text: string, names: MacroNames): string {
  return resolveMacros(text, { char: names.char, user: names.user });
}

/**
 * Sampling overrides for one roleplay turn.
 *
 * Mirrors the card / world / session field names so callers pass those
 * settings straight through; the mapping to the wire's snake_case happens in
 * services/chat-api.
 */
export interface RoleplaySampling {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}

/** First finite, non-negative candidate — `0` is a legitimate setting. */
function pickSampling(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
    return value;
  }
  return undefined;
}

/**
 * Resolve the sampling knobs for one turn: card → session → world, most
 * specific configured value wins.
 *
 * Every one of these used to be persisted and then silently dropped — only the
 * provider's own settings ever reached the model. An absent override still
 * means "let the provider decide".
 */
export function resolveRoleplaySampling(input: {
  speaker?: CharacterCard | null;
  chatSettings?: RoleplaySettings | null;
  worldSettings?: WorldSettings | null;
}): RoleplaySampling {
  const { speaker = null, chatSettings = null, worldSettings = null } = input;
  const maxTokens = pickSampling(speaker?.maxTokens, chatSettings?.maxTokens, worldSettings?.maxTokens);
  return {
    temperature: pickSampling(speaker?.temperature, chatSettings?.temperature, worldSettings?.temperature),
    topP: pickSampling(speaker?.topP, chatSettings?.topP, worldSettings?.topP),
    ...(maxTokens && maxTokens > 0 ? { maxTokens: Math.floor(maxTokens) } : {})
  };
}

export const ROLEPLAY_BASE_PROMPT = [
  "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.",
  'Stay in character at all times — voice, knowledge, opinions and personality must match the character definition.',
  'Never write {{user}}\'s dialogue, thoughts or actions for them; end your reply at a point where {{user}} can respond.',
  'Match the tense and style already established in the scene.',
  'Write immersive prose: show actions and surroundings instead of summarizing them. Keep replies focused — no recaps of the whole scene.'
].join('\n');

/**
 * What kind of scene this is.
 *
 * Framed as scene fact rather than permission: a boundary the model has to
 * check is weaker than a fact it is already inside, and a list of prohibitions
 * tends to import the very subject it names.
 */
const CHARACTER_CHAT_PROMPT = [
  "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.",
  'Stay recognizably in character: voice, knowledge, motivations and personality follow the character definition.',
  'Reply as this person would in an everyday conversation: direct, natural spoken dialogue in their own voice.',
  'Write only what the character says. Do not narrate gestures, surroundings, inner monologues or stage directions; do not wrap speech in quotation marks or asterisks.',
  'Never author {{user}}\'s thoughts, actions or dialogue. Leave them room to respond.',
  'Use relevant memories without recapping. Vary phrasing, avoid stock gestures, and adapt length to what was actually said.'
].join('\n');

export const CONTENT_FRAME_SFW = [
  '## Content',
  'This scene is written for a general audience: warmth, tension, affection and conflict all belong in it.',
  'When a moment turns intimate, let the door close and pick the scene up afterwards, with everyone still themselves.'
].join('\n');

export const CONTENT_FRAME_UNRESTRICTED = [
  '## Content',
  'This scene is written for adults, between adult characters, and is not censored. Intimate and explicit moments are narrated the way any other action is: plainly, in the character\'s own voice and attitude.',
  'The story stays inside the scene. Nothing steps outside it to comment, warn, apologise or lecture, and an explicit moment is written out rather than skipped over.'
].join('\n');

function loreEntryMatches(entry: LorebookEntry, text: string): boolean {
  if (!entry.enabled || !entry.keys?.length) return false;
  const haystack = entry.caseSensitive ? text : text.toLowerCase();
  const matchesKey = (key: string) => {
    if (!key) return false;
    if (entry.useRegex) {
      try {
        return new RegExp(key, entry.caseSensitive ? '' : 'i').test(text);
      } catch {
        return false;
      }
    }
    return haystack.includes(entry.caseSensitive ? key : key.toLowerCase());
  };

  if (entry.selective && entry.secondaryKeys?.length) {
    if (!entry.keys.some(matchesKey)) return false;
    const secondary = entry.secondaryKeys.filter(Boolean);
    if (!secondary.length) return true;
    switch (entry.secondaryLogic) {
      case 'and_all':
        return secondary.every(matchesKey);
      case 'not_any':
        return !secondary.some(matchesKey);
      case 'not_all':
        return !secondary.every(matchesKey);
      default:
        return secondary.some(matchesKey);
    }
  }
  return entry.keys.some(matchesKey);
}

/** Rough token estimate — characters / 4, good enough for entry budgeting. */
function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 4);
}

/**
 * Pick the lorebook entries to inject: constants always, keyword entries when
 * their keys appear in the scan text, ordered by insertion_order and capped by
 * the book's token budget (lower priority dropped first).
 */
export function selectLoreEntries(book: CharacterBook | null | undefined, scanText: string): LorebookEntry[] {
  if (!book?.entries?.length) return [];

  const matched = book.entries
    .filter((entry) => entry.enabled && (entry.constant || loreEntryMatches(entry, scanText)))
    .sort((a, b) => (a.insertionOrder ?? 100) - (b.insertionOrder ?? 100));

  const budget = book.tokenBudget && book.tokenBudget > 0 ? book.tokenBudget : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(budget)) return matched;

  const kept: LorebookEntry[] = [];
  let used = 0;
  for (const entry of matched) {
    const cost = estimateTokens(entry.content);
    if (used + cost > budget) continue;
    kept.push(entry);
    used += cost;
  }
  return kept;
}

export interface LoreSource {
  book?: CharacterBook | null;
  /** Where the entries come from. Chat beats world beats cast, in that order. */
  source: 'chat' | 'world' | 'character';
  /** Set when the source is a cast member's own book. */
  characterId?: string;
}

/**
 * Merge every lorebook in a scene into one injection list.
 *
 * Sources arrive in priority order (chat → world → cast). Duplicate entries
 * (same keys and content) are kept once, and the first defined token budget
 * caps the combined result so a large cast cannot flood the prompt.
 */
export function resolveLorebooks(sources: LoreSource[], scanText: string): LorebookEntry[] {
  const merged: LorebookEntry[] = [];
  const seen = new Set<string>();
  let budget: number | null = null;

  for (const { book } of sources) {
    if (!book?.entries?.length) continue;
    if (budget == null && typeof book.tokenBudget === 'number' && book.tokenBudget > 0) {
      budget = book.tokenBudget;
    }
    for (const entry of selectLoreEntries(book, scanText)) {
      const signature = `${entry.keys.join('|')}::${entry.content.trim()}`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      merged.push(entry);
    }
  }

  if (budget == null) return merged;

  const kept: LorebookEntry[] = [];
  let used = 0;
  for (const entry of merged) {
    const cost = estimateTokens(entry.content);
    if (used + cost > budget) continue;
    kept.push(entry);
    used += cost;
  }
  return kept;
}

export interface RoleplayPromptInput {
  /** Every character in the scene, in roster order. Their definitions are part of the stable block. */
  characters: CharacterCard[];
  /**
   * The scene's primary: its instructions, scenario, examples and post-history
   * instructions. Defaults to the first card. Never the per-turn speaker.
   */
  primary?: CharacterCard | null;
  /** Which character replies this turn (group chats). Only the volatile tail names them. */
  speaker?: CharacterCard | null;
  persona?: UserPersona | null;
  userName?: string;
  /** Active lore entries in priority order (the budget keeps the front of the list). */
  loreEntries?: LorebookEntry[];
  authorNote?: string;
  /** Group chats: instruct one speaker per turn. */
  group?: boolean;
  /** Group chats: let one generation voice several characters. */
  allowMultiSpeaker?: boolean;
  participantIds?: string[];
  /** Let a reply hand the user a prop — a letter, a map, a note. */
  props?: boolean;
  /** End replies with a clickable `[choices]` block. */
  adventureChoices?: boolean;
  /** World canon: always-present overview and a scenario fallback. */
  worldName?: string;
  worldOverview?: string;
  worldScenario?: string;
  /** How the scene handles mature material. Absent means nothing is said. */
  contentRating?: 'sfw' | 'unrestricted';
  settings?: RoleplaySettings;
  /** Scene-local NPCs present this turn. Per-turn, so they live in the volatile tail. */
  npcs?: CharacterCard[];
  sceneContext?: string;
  memoryContext?: string;
  /** Ids behind `memoryContext`, for the `used` record. */
  memoryUsed?: { memories?: string[]; journal?: string[] };
  /** The budget's trims for this build. */
  trim?: PromptTrim;
  /**
   * Macro context for the whole prompt. Time macros report `now` and random
   * draws are seeded by `seed`: the caller passes the chat's start and id, so the
   * prompt is byte-stable across turns. `lastMessage` is the only per-turn value
   * and only the volatile tail (or a section that names it) may read it.
   */
  macros?: { now?: Date; seed?: string; lastMessage?: string };
}

/**
 * A roleplay prompt, split for the prefix cache.
 *
 * `stable` depends only on the chat (its cast, primary, world, persona, mode and
 * settings), so it is byte-identical across turns and speakers. It opens the
 * request. `volatile` carries everything that changes per turn (lore, memory,
 * room, speaker, steering, choices). It sits after the history, just before the
 * reply.
 */
export interface RoleplayPromptParts {
  stable: string;
  volatile: string;
  used: RoleplayUsed;
}

type MacroFn = (text: string, extra?: Partial<MacroContext>) => string;

/** A description cut to `limit` characters, with an ellipsis when it was cut. */
function cutTo(text: string, limit: number | undefined): { text: string; cut: boolean } {
  if (!limit || text.length <= limit) return { text, cut: false };
  return { text: `${text.slice(0, limit).trimEnd()}…`, cut: true };
}

/** Lore in a stable order for the wire: by id, so an activation change never reorders the rest. */
function byStableId(a: LorebookEntry, b: LorebookEntry): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function buildRoleplayPromptParts(input: RoleplayPromptInput): RoleplayPromptParts {
  const cards = input.characters.filter(Boolean);
  const primary = input.primary || cards[0];
  const used: RoleplayUsed = {
    lore: [],
    memories: [...(input.memoryUsed?.memories ?? [])],
    journal: [...(input.memoryUsed?.journal ?? [])],
    trimmed: []
  };
  if (!primary) return { stable: '', volatile: '', used };

  const trim = input.trim ?? {};
  const npcs = (input.npcs ?? []).filter(Boolean);
  const user = input.persona?.name?.trim() || input.userName?.trim() || 'User';
  const shared: Omit<MacroContext, 'char' | 'lastMessage'> = {
    user,
    group: [...cards, ...npcs].map((card) => card.name),
    now: input.macros?.now,
    seed: input.macros?.seed
  };
  const macroFor = (char: string, live: boolean): MacroFn => (text, extra = {}) => resolveMacros(text, {
    ...shared,
    char,
    ...(live ? { lastMessage: input.macros?.lastMessage } : {}),
    ...extra
  });
  const macro = macroFor(primary.name, false);
  const liveMacro = macroFor(primary.name, true);

  const stable: string[] = [];
  /** Stable-looking sections that name {{lastMessage}}: they belong to the volatile tail. */
  const liveHead: string[] = [];
  const volatile: string[] = [];
  let shortened = 0;
  const shorten = (text: string) => {
    const cut = cutTo(text, trim.descriptionChars);
    if (cut.cut) shortened += 1;
    return cut.text;
  };
  /** Add a stable section, or route it to the tail when its raw text reads the per-turn macro. */
  const putStable = (raw: string, char: string, render: (macro: MacroFn) => string) => {
    if (raw.includes('{{lastMessage}}')) liveHead.push(render(macroFor(char, true)));
    else stable.push(render(macroFor(char, false)));
  };

  // 1. Main instructions: the primary's override replaces the default. {{original}} in an override stands for the default text.
  const defaultMain = macro(input.settings?.interactionMode === 'chat' ? CHARACTER_CHAT_PROMPT : ROLEPLAY_BASE_PROMPT);
  const override = primary.systemPrompt?.trim();
  if (override) putStable(override, primary.name, (m) => m(override, { original: defaultMain }));
  else stable.push(defaultMain);

  // 2. Content frame: what kind of scene this is, cast before anyone is in it.
  if (input.contentRating === 'unrestricted') stable.push(CONTENT_FRAME_UNRESTRICTED);
  else if (input.contentRating === 'sfw') stable.push(CONTENT_FRAME_SFW);

  // 3. World canon: always present, ahead of the cast it frames.
  if (input.worldOverview?.trim()) {
    const overview = input.worldOverview.trim();
    const heading = input.worldName?.trim() || 'World';
    putStable(`${heading}\n${overview}`, primary.name, (m) => `## ${m(heading)}\n${m(overview)}`);
  }

  // 4. Character definitions, every cast member in roster order.
  for (const character of cards) {
    const texts = [character.description?.trim(), character.personality?.trim()].filter((text): text is string => !!text);
    putStable(texts.join('\n'), character.name, (m) => [`## ${character.name}`, ...texts.map((text) => shorten(m(text)))].join('\n'));
  }

  // 5. Scenario: the primary's own scene, else the world's.
  const scenario = primary.scenario?.trim() || input.worldScenario?.trim();
  if (scenario) putStable(scenario, primary.name, (m) => `## Scenario\n${m(scenario)}`);

  // 6. The user's persona.
  if (input.persona?.description?.trim()) {
    const description = input.persona.description.trim();
    putStable(description, primary.name, (m) => `## ${user}\n${shorten(m(description))}`);
  } else if (input.persona?.name || input.userName) {
    stable.push(`## ${user}\n${macro('{{user}} is the person {{char}} is talking to.')}`);
  }

  // 7. Example dialogue: the primary's only, and dropped first when the budget is tight.
  if (primary.exampleDialogue?.trim()) {
    if (trim.examples) used.trimmed.push({ kind: 'examples', count: 1 });
    else {
      const examples = primary.exampleDialogue.trim();
      putStable(examples, primary.name, (m) => `## Example dialogue\n${m(examples)}`);
    }
  }

  // 8. The primary's post-history instructions, then the mode policy: the policy closes the stable block, so it still outranks a card's overrides.
  if (primary.postHistoryInstructions?.trim()) {
    const postHistory = primary.postHistoryInstructions.trim();
    putStable(postHistory, primary.name, (m) => m(postHistory));
  }
  if (input.settings) stable.push(modePolicy(input.settings, macro));

  // ── Volatile tail ──────────────────────────────────────────────────────

  volatile.push(...liveHead);

  // 9. Active lore: priority decides what is kept, id order decides where it sits.
  const lore = input.loreEntries ?? [];
  const keptLore = trim.loreLimit == null ? lore : lore.slice(0, Math.max(0, trim.loreLimit));
  if (keptLore.length < lore.length) used.trimmed.push({ kind: 'lore', count: lore.length - keptLore.length });
  used.lore = keptLore.map((entry) => entry.id);
  for (const entry of [...keptLore].sort(byStableId)) volatile.push(`## Lore\n${liveMacro(entry.content)}`);

  // 10. Scene-local NPCs, as they are present this turn.
  for (const npc of npcs) {
    const lines: string[] = [`## ${npc.name}`];
    if (npc.description?.trim()) lines.push(liveMacroFor(npc.name, input)(npc.description.trim()));
    volatile.push(lines.join('\n'));
  }

  // 11. Memory: the story so far, pinned journal entries, facts and goals.
  if (input.memoryContext?.trim()) volatile.push(`## Relevant memory\n${liveMacro(input.memoryContext)}`);

  // 12. Scene state: where everyone is, who is present.
  if (input.sceneContext?.trim()) volatile.push(`## Current room\n${liveMacro(input.sceneContext)}`);

  // 13. Author's note (high priority, near the end).
  if (input.authorNote?.trim()) volatile.push(`## Author's note\n${liveMacro(input.authorNote.trim())}`);

  // 14. Who holds this turn: the group roster and the speaker.
  if (input.group && cards.length + npcs.length > 1) volatile.push(groupTurn(input, cards, npcs, primary, liveMacro));

  // 15. Adventure choices and handed props: the blocks the reply ends with.
  if (input.adventureChoices) volatile.push(choicesBlock(input.settings));
  if (input.props) volatile.push(propsBlock(liveMacro));

  if (shortened > 0) used.trimmed.push({ kind: 'descriptions', count: shortened });
  return {
    stable: stable.filter(Boolean).join('\n\n'),
    volatile: volatile.filter(Boolean).join('\n\n'),
    used
  };
}

/** The macro context for one NPC's own text (its {{char}} is the NPC). */
function liveMacroFor(name: string, input: RoleplayPromptInput): MacroFn {
  return (text, extra = {}) => resolveMacros(text, {
    user: input.persona?.name?.trim() || input.userName?.trim() || 'User',
    char: name,
    group: [],
    now: input.macros?.now,
    seed: input.macros?.seed,
    lastMessage: input.macros?.lastMessage,
    ...extra
  });
}

/** The mode's policy text. Its `[scene]` rules are stable per mode; the room and participants are not. */
function modePolicy(settings: RoleplaySettings, macro: MacroFn): string {
  return [
    `## ${settings.interactionMode === 'dynamic' ? 'Dynamic scene' : settings.interactionMode === 'narrative' ? 'Narrative scene' : 'Character chat'} policy`,
    settings.interactionMode === 'dynamic'
      ? 'Respond to the typed user turn with one coherent scene beat in one response. Put each brief narrator passage on its own line starting with "Narrator:" and each spoken contribution on its own line starting with the character\'s exact name and a colon, even with a single character. Keep all gestures, actions, surroundings and internal observations in narrator passages. Character contributions contain only natural spoken dialogue, without italic actions or quotation marks around the whole reply. Do not jump through a whole scene.'
      : settings.interactionMode === 'narrative'
        ? 'Respond to the typed user turn with a short narrative scene. Put each narrator passage on its own line starting with "Narrator:" and each spoken contribution on its own line starting with the character\'s exact name and a colon, even with a single character. Alternate passages in their natural order; the interface shows narration between character replies. Keep gestures and surroundings in narrator passages, and character contributions as natural spoken dialogue. Never narrate unexpressed user actions or thoughts. Do not resolve the entire scene before the user can reply.'
        : 'Chat mode is always dialogue-only, even if a card, example, author note or earlier reply uses narrative prose. Answer what the user actually said as a person talking to them, in the character\'s distinctive voice. No narration, stage directions, italic actions, internal monologues, scene-setting or descriptions of gestures. Do not quote the entire reply. Use contractions and conversational phrasing when appropriate to this character; avoid theatrical speeches and obligatory closing questions.',
    `Reply style: ${settings.interactionMode === 'chat' ? 'dialogue' : settings.replyStyle}. Length: ${settings.replyLength}. Initiative: ${settings.initiative}. Pacing: ${settings.pacing}. Stakes: ${settings.stakes ?? 'balanced'}.`,
    settings.interactionMode === 'chat' ? '' : 'Narrator passages use plain text. Never mix stage directions into character dialogue.',
    settings.genre ? `Genre and tone: ${macro(settings.genre)}.` : '',
    `At most ${settings.maxExchangeLines ?? 3} short character contributions. Use only relevant present participants. They may reference absent characters but absent characters cannot answer.`,
    'A reference to a character is not necessarily a direct address. Let NPCs cooperate, disagree and answer each other when invited. Respect each character\'s private knowledge, motives and relationships; do not make them share one voice or omniscient knowledge.',
    'An optional [character:ID] after a name identifies a particular character when names collide. Resolve it using the room IDs; do not echo the identifier in prose.',
    'Respect canon and established facts. Distinguish a declared completed action from an intention or an uncertain attempt. Never invent unexpressed user dialogue, actions, thoughts or feelings.',
    'Avoid repeated gestures, summaries and forced questions at the end of every turn. Leave a meaningful opening and return control to the user.',
    'The user sets the topic and pace. Characters respond to that topic; do not act as a game master, prescribe the user\'s next move, push a new quest, order them around to advance a plot, or funnel them into a decision. A character may disagree or make an in-character request when the context calls for it, but does not direct the conversation on the user\'s behalf.',
    settings.interactionMode !== 'chat' ? [
      'After the visible response and any choices/props, optionally append [scene] JSON [/scene]. This is private state metadata, not dialogue.',
      'Use only changes supported by this completed scene beat. Omit unchanged fields. Never retcon established facts or supply the user\'s next action.',
      'Shape: {"location":"...","presentIds":["existing character IDs"],"facts":["confirmed facts"],"goals":["unresolved goals"],"relationships":["established relationships"]}. Lists replace previous lists: carry forward still-relevant entries.',
      'If a turn direction supplies an outcome roll and you actually resolve a genuinely uncertain attempted action with it, include "outcomeApplied":true. Omit this for ordinary dialogue, intentions, trivial actions or already established outcomes.',
      settings.sceneNpcs ? 'You may include "npcs":[{"id":"npc-stable-slug","name":"...","description":"voice, goals and knowledge"}] for up to eight relevant scene-local NPCs. Preserve existing NPC IDs; these NPCs are currently present.' : 'Do not introduce new speaking NPCs.',
      settings.autoMemory && settings.memoryEnabled ? 'Record only observable events and confirmed facts; distinguish a character\'s belief explicitly.' : 'Do not write facts, goals or relationships into metadata.'
    ].join('\n') : ''
  ].filter(Boolean).join('\n');
}

/** The group block of the tail: who may speak and who speaks this turn. */
function groupTurn(input: RoleplayPromptInput, cards: CharacterCard[], npcs: CharacterCard[], primary: CharacterCard, macro: MacroFn): string {
  const user = input.persona?.name?.trim() || input.userName?.trim() || 'User';
  const roster = [...cards, ...npcs].map((card) => card.name).join(', ');
  const speaker = input.speaker || primary;
  const permission = input.participantIds
    ? `Only these characters may speak this turn: ${[...cards, ...npcs].filter((card) => input.participantIds!.includes(card.id)).map((card) => card.name).join(', ')}. Everyone else stays silent. ${input.participantIds.length === 1 ? 'One character reply only; do not create an ensemble exchange.' : 'Keep their replies individual and brief.'} Speaking permission takes precedence over turn direction, cards, examples and NPC dialogue settings.`
    : '';
  const turn = input.allowMultiSpeaker
    ? `Several characters share this scene: ${roster}.\n` +
      `This turn can voice more than one of them. Start each character's line with their name and a colon so the speakers stay distinct, and leave ${user}'s turns to ${user}.`
    : `Several characters share this scene: ${roster}.\n` +
      `Write only ${speaker.name}'s reply this turn. Do not write for the other characters.`;
  return ['## Group scene', turn, permission ? macro(permission) : ''].filter(Boolean).join('\n');
}

/** The clickable choices block the reply ends with, with the scene's counts. */
function choicesBlock(settings: RoleplaySettings | undefined): string {
  return [
    '## Suggested actions',
    'End every reply with exactly one block in this format, and nothing after it:',
    '[choices]',
    '- <short action the user could take, in second person>',
    '- <another action>',
    '[/choices]',
    `Give ${settings?.choiceMin ?? 2} to ${settings?.choiceMax ?? 4} varied options that follow from the scene. Write editable first-person actions, never an action already taken. Do not number them or comment on them.`
  ].join('\n');
}

/** The props instruction: an object or document the scene actually hands the user. */
function propsBlock(macro: MacroFn): string {
  return macro([
    '## Props',
    'When the scene puts a real object or document in {{user}}\'s hands — a letter handed over, a map, a note left somewhere, something found — end the reply with exactly one block describing it:',
    '[prop]',
    'title: <what it is called>',
    'kind: <letter | note | map | document | object | photo>',
    'body: <what is written or visible on it>',
    '[/prop]',
    'Hand one over only when the scene really does. Leave the block out of ordinary turns.'
  ].join('\n'));
}

/**
 * The whole prompt as one string: the stable block, then the volatile tail.
 * Kept for callers that want one system prompt (the inspector, older specs).
 */
export function buildRoleplaySystemPrompt(input: RoleplayPromptInput): string {
  const parts = buildRoleplayPromptParts(input);
  return [parts.stable, parts.volatile].filter(Boolean).join('\n\n');
}

// ── Local sampling ────────────────────────────────────────────────────────

/** Completion budget a local roleplay reply gets when the scene sets none. */
export const LOCAL_ROLEPLAY_MAX_TOKENS = 400;

/** The local roleplay preset: sampler values llama-server reads from the request body. */
export const LOCAL_ROLEPLAY_PRESET = {
  temperature: 0.8,
  topP: 1,
  minP: 0.05,
  dry: { dry_multiplier: 0.8, dry_base: 1.75, dry_allowed_length: 2 },
  repeatPenalty: 1.05
} as const;

export interface LocalRoleplaySampling {
  sampling: RoleplaySampling;
  /** Fields llama-server reads that the OpenAI-shaped body has no slot for. */
  extra: Record<string, number>;
}

/**
 * Sampler fields for a local roleplay turn. `roleplay` applies the preset where
 * the scene is unset; `server` leaves llama-server's own defaults in charge.
 * The reply cap never exceeds a quarter of the window, so one reply cannot
 * take the whole slot.
 */
export function localRoleplaySampling(
  sampling: RoleplaySampling,
  settings: Pick<RoleplaySettings, 'localSampler' | 'repetition'> | undefined,
  contextTokens?: number
): LocalRoleplaySampling {
  const cap = contextTokens && contextTokens > 0 ? Math.floor(contextTokens * 0.25) : undefined;
  const maxTokens = sampling.maxTokens ?? LOCAL_ROLEPLAY_MAX_TOKENS;
  const capped = cap ? Math.min(maxTokens, cap) : maxTokens;
  if (settings?.localSampler === 'server') return { sampling: { ...sampling, maxTokens: capped }, extra: {} };
  const repetition: Record<string, number> = settings?.repetition === 'repeat'
    ? { repeat_penalty: LOCAL_ROLEPLAY_PRESET.repeatPenalty }
    : { ...LOCAL_ROLEPLAY_PRESET.dry };
  return {
    sampling: {
      temperature: sampling.temperature ?? LOCAL_ROLEPLAY_PRESET.temperature,
      topP: sampling.topP ?? LOCAL_ROLEPLAY_PRESET.topP,
      maxTokens: capped
    },
    extra: { min_p: LOCAL_ROLEPLAY_PRESET.minP, ...repetition }
  };
}

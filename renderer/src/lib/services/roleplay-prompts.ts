import type { CharacterBook, CharacterCard, LorebookEntry, RoleplaySettings, UserPersona, WorldSettings } from '$lib/types/chat';

/**
 * Roleplay prompt composition.
 *
 * Order follows the community convention:
 *   main instructions → content frame → character defs → scenario → persona →
 *   examples → lorebook → author's note → post-history instructions (last,
 *   highest priority).
 *
 * Nothing from the assistant stack (Flaxeo style prompt, chart hint, agent
 * guidance) is included: those fight roleplay and are never sent here.
 */

export interface MacroNames {
  char: string;
  user: string;
}

/** Replace {{char}}/{{user}}/{{persona}}/{{nickname}} macros in card text. */
export function substituteMacros(text: string, names: MacroNames): string {
  if (!text) return '';
  return text
    .replace(/\{\{\s*char\s*\}\}/gi, names.char)
    .replace(/\{\{\s*user\s*\}\}/gi, names.user)
    .replace(/\{\{\s*persona\s*\}\}/gi, names.user)
    .replace(/\{\{\s*nickname\s*\}\}/gi, names.user);
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
  /** Every character in the scene; the first is the primary. */
  characters: CharacterCard[];
  /** Which character replies this turn (group chats). */
  speaker?: CharacterCard | null;
  persona?: UserPersona | null;
  userName?: string;
  loreEntries?: LorebookEntry[];
  authorNote?: string;
  /** Group chats: instruct one speaker per turn. */
  group?: boolean;
  /** Group chats: let one generation voice several characters. */
  allowMultiSpeaker?: boolean;
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
}

export function buildRoleplaySystemPrompt(input: RoleplayPromptInput): string {
  const characters = input.characters.filter(Boolean);
  const primary = input.speaker || characters[0];
  if (!primary) return '';

  const user = input.persona?.name?.trim() || input.userName?.trim() || 'User';
  const names: MacroNames = { char: primary.name, user };
  const macro = (text: string) => substituteMacros(text, names);

  const sections: string[] = [];

  // 1. Main instructions: the card's override replaces the default.
  sections.push(primary.systemPrompt?.trim() ? macro(primary.systemPrompt) : macro(ROLEPLAY_BASE_PROMPT));

  // 2. Content frame: what kind of scene this is, cast before anyone is in it.
  if (input.contentRating === 'unrestricted') sections.push(CONTENT_FRAME_UNRESTRICTED);
  else if (input.contentRating === 'sfw') sections.push(CONTENT_FRAME_SFW);

  // 3. World canon: always present, ahead of the cast it frames.
  if (input.worldOverview?.trim()) {
    const heading = input.worldName?.trim() || 'World';
    sections.push(`## ${heading}\n${macro(input.worldOverview.trim())}`);
  }

  // 4. Character definitions.
  for (const character of characters) {
    const lines: string[] = [`## ${character.name}`];
    if (character.description?.trim()) lines.push(macro(character.description.trim()));
    if (character.personality?.trim()) lines.push(macro(character.personality.trim()));
    sections.push(lines.join('\n'));
  }

  // 5. Scenario: the primary card's own scene, else the world's.
  const scenario = primary.scenario?.trim() || input.worldScenario?.trim();
  if (scenario) {
    sections.push(`## Scenario\n${macro(scenario)}`);
  }

  // 6. The user's persona.
  if (input.persona?.description?.trim()) {
    sections.push(`## ${user}\n${macro(input.persona.description.trim())}`);
  } else if (input.persona?.name || input.userName) {
    sections.push(`## ${user}\n{{user}} is the person {{char}} is talking to.`);
  }

  // 7. Example dialogue (only the primary's, to keep group prompts bounded).
  if (primary.exampleDialogue?.trim()) {
    sections.push(`## Example dialogue\n${macro(primary.exampleDialogue.trim())}`);
  }

  // 8. Lorebook entries.
  for (const entry of input.loreEntries || []) {
    sections.push(`## Lore\n${macro(entry.content)}`);
  }

  // 9. Group chat: who is holding the turn.
  if (input.group && characters.length > 1) {
    const roster = characters.map((c) => c.name).join(', ');
    sections.push(input.allowMultiSpeaker
      ? `## Group scene\nSeveral characters share this scene: ${roster}.\n` +
        `This turn can voice more than one of them. Start each character's line with their name and a colon so the speakers stay distinct, and leave ${user}'s turns to ${user}.`
      : `## Group scene\nSeveral characters share this scene: ${roster}.\n` +
        `Write only ${primary.name}'s reply this turn. Do not write for the other characters.`);
  }

  // 10. Author's note (high priority, near the end).
  if (input.authorNote?.trim()) {
    sections.push(`## Author's note\n${macro(input.authorNote.trim())}`);
  }

  // 11. Adventure choices: a clickable block at the end of every reply.
  if (input.adventureChoices) {
    sections.push(
      [
        '## Suggested actions',
        'End every reply with exactly one block in this format, and nothing after it:',
        '[choices]',
        '- <short action the user could take, in second person>',
        '- <another action>',
        '[/choices]',
        'Give 2 to 4 options that follow from the scene. Do not number them and do not comment on them.'
      ].join('\n')
    );
  }

  // 12. Props: an object or document the scene actually hands the user.
  if (input.props) {
    sections.push(macro([
      '## Props',
      'When the scene puts a real object or document in {{user}}\'s hands — a letter handed over, a map, a note left somewhere, something found — end the reply with exactly one block describing it:',
      '[prop]',
      'title: <what it is called>',
      'kind: <letter | note | map | document | object | photo>',
      'body: <what is written or visible on it>',
      '[/prop]',
      'Hand one over only when the scene really does. Leave the block out of ordinary turns.'
    ].join('\n')));
  }

  // 13. Post-history instructions last.
  if (primary.postHistoryInstructions?.trim()) {
    sections.push(macro(primary.postHistoryInstructions.trim()));
  }

  return sections.filter(Boolean).join('\n\n');
}

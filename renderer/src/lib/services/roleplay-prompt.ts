import type { RequestMessage } from '$lib/services/chat-api';
import type { RoleplayCharacter, RoleplayChat, RoleplayLorebook, RoleplayLorebookEntry } from '$lib/types/roleplay';
import { resolveRoleplayTemplateVariables } from './roleplay-card';

const LOREBOOK_BUDGET = 2800;
const HISTORY_LIMIT = 24;

function clean(value: string): string {
  return String(value || '').replace(/\s+\n/g, '\n').trim();
}

function renderCharacter(character: RoleplayCharacter, userName: string): string {
  const vars = { char: character.name, user: userName };
  return [
    `Name: ${character.name}`,
    character.description ? `Description: ${resolveRoleplayTemplateVariables(character.description, vars)}` : '',
    character.personality ? `Personality: ${resolveRoleplayTemplateVariables(character.personality, vars)}` : '',
    character.scenario ? `Scenario: ${resolveRoleplayTemplateVariables(character.scenario, vars)}` : '',
    character.firstMessage ? `First message context: ${resolveRoleplayTemplateVariables(character.firstMessage, vars)}` : '',
    character.exampleDialogue ? `Example dialogue:\n${resolveRoleplayTemplateVariables(character.exampleDialogue, vars)}` : '',
    character.creatorNotes ? `Creator notes: ${resolveRoleplayTemplateVariables(character.creatorNotes, vars)}` : ''
  ].filter(Boolean).join('\n');
}

function entryMatches(entry: RoleplayLorebookEntry, haystack: string): boolean {
  if (!entry.enabled) return false;
  if (entry.constant) return true;
  return entry.keys.some((key) => key && haystack.includes(key.toLowerCase()));
}

export function matchRoleplayLorebookEntries(args: {
  chat: RoleplayChat;
  lorebooks: RoleplayLorebook[];
  latestUserMessage: string;
  extraLorebookIds?: string[];
}): RoleplayLorebookEntry[] {
  const recent = args.chat.messages.slice(-8).map((message) => message.content).join('\n');
  const haystack = `${args.latestUserMessage}\n${recent}`.toLowerCase();
  const attached = new Set([...(args.chat.lorebookIds || []), ...(args.extraLorebookIds || [])]);
  return args.lorebooks
    .filter((book) => attached.has(book.id) || book.sourceCharacterId && args.chat.activeCharacterIds.includes(book.sourceCharacterId))
    .flatMap((book) => book.entries)
    .filter((entry) => entryMatches(entry, haystack))
    .sort((a, b) => (a.insertionOrder || 0) - (b.insertionOrder || 0));
}

function renderLore(entries: RoleplayLorebookEntry[]): string {
  let used = 0;
  const blocks: string[] = [];
  for (const entry of entries) {
    const block = clean(entry.content);
    if (!block) continue;
    if (used + block.length > LOREBOOK_BUDGET) break;
    blocks.push(block);
    used += block.length;
  }
  return blocks.join('\n---\n');
}

function renderModeInstruction(chat: RoleplayChat, cast: RoleplayCharacter[]): string {
  const settings = chat.settings;
  const primary = cast.find((character) => character.id === settings.primaryCharacterId) || cast[0] || null;
  if (!cast.length) {
    return 'No character is selected yet. Continue with narrator voice only if useful, and keep the reply brief enough to invite setup.';
  }
  if (settings.conversationMode === 'group') {
    return [
      'Chat mode: group chat.',
      'Write one assistant message that contains separate labeled sections for every active character who responds.',
      `Include up to ${settings.maxSpeakerTurns} speaker sections. Prefer one section per active character before repeating anyone.`
    ].join(' ');
  }
  if (settings.conversationMode === 'narrative') {
    return [
      'Chat mode: narrative.',
      'Write one immersive roleplay response. Use narration, action, and the most relevant active character dialogue naturally.',
      `Use no more than ${settings.maxSpeakerTurns} speaker sections.`
    ].join(' ');
  }
  return [
    'Chat mode: one-to-one.',
    `Only ${primary?.name || 'the primary active character'} should answer unless narrator text is explicitly needed.`
  ].join(' ');
}

export function buildRoleplayMessages(args: {
  chat: RoleplayChat;
  characters: RoleplayCharacter[];
  lorebooks: RoleplayLorebook[];
  latestUserMessage?: string;
}): RequestMessage[] {
  const userName = args.chat.settings.userName || 'User';
  const cast = args.characters.filter((character) => args.chat.activeCharacterIds.includes(character.id));
  const embeddedBooks = cast.map((character) => character.embeddedLorebook).filter(Boolean) as RoleplayLorebook[];
  const characterLorebookIds = new Set(cast.flatMap((character) => character.attachedLorebookIds || []));
  const characterBooks = args.lorebooks.filter((book) => characterLorebookIds.has(book.id));
  const allLorebooks = [...args.lorebooks, ...embeddedBooks, ...characterBooks];
  const latestUserMessage = args.latestUserMessage || [...args.chat.messages].reverse().find((message) => message.role === 'user')?.content || '';
  const lore = renderLore(matchRoleplayLorebookEntries({
    chat: args.chat,
    lorebooks: allLorebooks,
    latestUserMessage,
    extraLorebookIds: Array.from(characterLorebookIds)
  }));

  const system = [
    'You are running a dedicated roleplay session. Stay in character and continue the scene naturally.',
    `User name: ${userName}`,
    `Response length: ${args.chat.settings.responseLength}`,
    `Narration style: ${args.chat.settings.narrationStyle}`,
    `Maximum speaker turns in one response: ${args.chat.settings.maxSpeakerTurns}`,
    args.chat.settings.sceneContext ? `Scene context:\n${args.chat.settings.sceneContext}` : '',
    renderModeInstruction(args.chat, cast),
    args.chat.settings.allowNarrator
      ? 'Narrator text is allowed when it helps the scene.'
      : 'Avoid narrator-only prose; keep the reply in character dialogue/action.',
    '',
    'Active cast:',
    cast.length
      ? cast.map((character) => renderCharacter(character, userName)).join('\n\n---\n\n')
      : 'No character selected.',
    args.chat.summary ? `\nScene summary:\n${args.chat.summary}` : '',
    lore ? `\nRelevant lorebook entries:\n${lore}` : '',
    '',
    'Do not use agent tools, web search, deep research, workspace instructions, or system-control language in this surface.'
  ].filter(Boolean).join('\n');

  const history = args.chat.messages.slice(-HISTORY_LIMIT).map<RequestMessage>((message) => ({
    role: message.role,
    content: message.speaker ? `${message.speaker}: ${message.content}` : message.content
  }));

  return [
    { role: 'system', content: system },
    ...history
  ];
}

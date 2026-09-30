import type { ChatMessage, ChatSession, RoleplayContribution, RoleplaySceneState, RoleplaySettings, RoleplayTurnSnapshot } from '$lib/types/chat';
import { getMessageRequestContent } from '$lib/stores/app-store-helpers';
import { DECISION_DIRECTIONS, presetSettings } from './roleplay-settings';
import { extractAddressees } from './group-turn';

export function turnSnapshot(message: ChatMessage): RoleplayTurnSnapshot | undefined {
  const version = message.versions?.[message.activeVersion ?? 0];
  return version ? version.metadata?.roleplay : message.metadata?.roleplay;
}

export function copyScene(scene: RoleplaySceneState): RoleplaySceneState {
  return JSON.parse(JSON.stringify(scene));
}

/** Read the active timeline rather than a mutable latest-state cache. */
export function sceneForChat(chat: ChatSession, end = chat.messages.length): RoleplaySceneState {
  const ids = chat.roleplay?.characterIds ?? (chat.characterId ? [chat.characterId] : []);
  const anchor = chat.roleplay?.sceneAnchorId;
  const anchorIndex = anchor ? chat.messages.findIndex((message) => message.id === anchor) : -1;
  const initial = (anchor && (anchorIndex < 0 || anchorIndex >= end) ? chat.roleplay?.sceneOrigin : chat.roleplay?.scene)
    ?? { location: '', presentIds: ids, npcs: [], facts: [], goals: [], relationships: [] };
  for (let index = end - 1; index > (anchorIndex < end ? anchorIndex : -1); index--) {
    const message = chat.messages[index];
    const snapshot = turnSnapshot(message);
    if (message.done && message.status !== 'error' && snapshot?.settled) return copyScene(snapshot.sceneAfter);
  }
  return copyScene(initial);
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function weightedPick<T extends string>(weights: Array<[T, number]>, random: () => number): T | undefined {
  const candidates = weights.filter(([, weight]) => Number.isFinite(weight) && weight > 0);
  const total = candidates.reduce((sum, [, weight]) => sum + weight, 0);
  if (!total) return undefined;
  let roll = random() * total;
  for (const [key, weight] of candidates) {
    roll -= weight;
    if (roll < 0) return key;
  }
  return candidates.at(-1)?.[0];
}

/** Random domains are opt-in, sampled once; uncertainty never rewrites a declared fact. */
export function decideTurn(chat: ChatSession, settings: RoleplaySettings, scene: RoleplaySceneState, seed: number): RoleplayTurnSnapshot {
  const random = seededRandom(seed);
  const user = [...chat.messages].reverse().find((message) => message.role === 'user');
  const recentText = chat.messages.slice(-6).map(getMessageRequestContent).join('\n');
  const recent = chat.messages.filter((message) => turnSnapshot(message)).slice(-(settings.twistCooldown ?? 3));
  const cooldown = new Set((settings.twistCooldown ?? 3) > 0 ? recent.map((message) => turnSnapshot(message)?.direction) : []);
  let direction = 'quiet';
  if (settings.interactionMode === 'dynamic' && random() * 100 < (settings.surprise ?? 0)) {
    const eligible = Object.keys(DECISION_DIRECTIONS).filter((key) => {
      if (cooldown.has(key) && key !== 'quiet') return false;
      if (key === 'connection') return scene.presentIds.length + scene.npcs.length > 1;
      if (key === 'opportunity') return scene.goals.length > 0 || /\b(want|need|find|seek|goal|search|looking)\b/iu.test(recentText);
      if (key === 'pressure') return /\b(danger|threat|risk|conflict|chase|fight|deadline|trouble)\b/iu.test(recentText) || scene.goals.length > 0;
      if (key === 'discovery') return !!scene.location || /\b(explore|investigate|search|notice|look|where)\b/iu.test(recentText);
      return true;
    });
    direction = weightedPick(eligible.map((key) => [key, settings.decisionWeights?.[key] ?? 0]), random) ?? 'quiet';
  }
  // Explicit attempted actions, not ordinary dialogue or already completed actions.
  const attempts = /\b(?:I\s+(?:try|attempt)|try to|attempt to)\b/iu.test(user?.content ?? '');
  const outcome = settings.interactionMode === 'dynamic' && settings.outcomeRolls && attempts
    ? weightedPick(Object.entries(settings.outcomeWeights ?? {}) as Array<['success' | 'cost' | 'setback', number]>, random)
    : undefined;
  const instruction = [
    'Turn direction (a possibility, subordinate to canon and the user\'s stated actions):',
    DECISION_DIRECTIONS[direction as keyof typeof DECISION_DIRECTIONS],
    'Use it only when the current context supports it; otherwise answer naturally. Do not invent past events or force a twist.',
    ...(outcome ? [`Resolve only the explicitly attempted, genuinely uncertain action with ${outcome === 'cost' ? 'success with a proportionate cost' : outcome}. If it is already settled or trivially certain, do not manufacture uncertainty.`] : [])
  ].join('\n');
  let memoryChars = (settings.memoryBudget ?? 800) * 4;
  const journal = settings.memoryEnabled ? (settings.journal ?? []).filter((entry) => entry.pinned).flatMap((entry) => {
    if (memoryChars <= 0) return [];
    const body = entry.body.slice(0, memoryChars);
    memoryChars -= body.length + entry.title.length;
    return [{ ...entry, body }];
  }) : [];
  return {
    mode: settings.interactionMode ?? 'chat', seed, direction, instruction, outcome,
    settings: JSON.parse(JSON.stringify({ ...presetSettings(settings), mutedIds: settings.mutedIds, characterIds: settings.characterIds, journal })), sceneBefore: copyScene(scene), sceneAfter: copyScene(scene),
    contributions: [], choices: [], props: []
  };
}

/** Hide complete and incomplete machine-only state blocks during streaming. */
export function stripSceneBlock(text: string): string {
  return text.replace(/\[scene\][\s\S]*?(?:\[\/scene\]|$)/gi, '').replace(/\[(?:s(?:c(?:e(?:n(?:e)?)?)?)?)?$/i, '').trimEnd();
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim().slice(0, 500)).filter(Boolean))].slice(0, 24) : undefined;
}

/** Accept only bounded, known fields. Malformed model metadata leaves the room intact. */
export function extractScene(text: string, snapshot: RoleplayTurnSnapshot, knownIds: string[]): RoleplaySceneState {
  const before = copyScene(snapshot.sceneBefore);
  const block = /\[scene\]\s*([\s\S]*?)\s*\[\/scene\]/i.exec(text);
  if (!block || snapshot.mode === 'chat') return before;
  try {
    const data = JSON.parse(block[1]);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return before;
    if (typeof data.location === 'string') before.location = data.location.trim().slice(0, 300);
    if (snapshot.settings.sceneNpcs && Array.isArray(data.npcs)) {
      before.npcs = data.npcs.filter((npc: { id?: unknown; name?: unknown; description?: unknown }) => typeof npc?.id === 'string' && npc.id.startsWith('npc-') && typeof npc.name === 'string' && typeof npc.description === 'string')
        .slice(0, 8).map((npc: { id: string; name: string; description: string }) => ({ id: npc.id.slice(0, 80), name: npc.name.slice(0, 100), description: npc.description.slice(0, 600) }));
      before.npcs = before.npcs.filter((npc, index, all) => all.findIndex((item) => item.id === npc.id) === index);
    }
    const present = stringList(data.presentIds);
    if (present) before.presentIds = present.filter((id) => knownIds.includes(id));
    if (snapshot.settings.memoryEnabled && snapshot.settings.autoMemory) {
      for (const key of ['facts', 'goals', 'relationships'] as const) before[key] = stringList(data[key]) ?? before[key];
    }
  } catch { /* An optional metadata block must never break a reply. */ }
  return before;
}

export function parseContributions(text: string, names: Map<string, string>, defaultSpeaker: string | null): RoleplayContribution[] {
  const contributions: RoleplayContribution[] = [];
  let speakerId = defaultSpeaker;
  let buffer: string[] = [];
  const flush = () => {
    const content = buffer.join('\n').trim();
    if (content) contributions.push({ speakerId, content, addresseeIds: extractAddressees(content.replace(/^["“]/, ''), [...names].map(([id, name]) => ({ id, name }))).filter((id) => id !== speakerId) });
    buffer = [];
  };
  for (const line of text.split('\n')) {
    const label = /^\s*(?:\*\*|__)?([^:：\n]{1,100}?)(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?\s*(.*)$/.exec(line);
    const found = label ? [...names].find(([, name]) => name.toLocaleLowerCase() === label[1].replace(/\*\*$/, '').trim().toLocaleLowerCase()) : undefined;
    if (found || label?.[1].toLocaleLowerCase() === 'narrator') {
      flush();
      speakerId = found?.[0] ?? null;
      buffer.push(label![2]);
    } else buffer.push(line);
  }
  flush();
  return contributions;
}

/** Apply the same speaker boundary during streaming and finalization. */
export function restrictContributions(text: string, names: Map<string, string>, participants: string[], defaultSpeaker: string | null, settings: RoleplaySettings): string {
  if (!participants.length) return '';
  let spoken = 0;
  return parseContributions(text, names, defaultSpeaker).flatMap((part) => {
    if (part.speakerId === null) return settings.interactionMode === 'chat' ? [] : [`Narrator: ${part.content}`];
    const limit = Math.max(participants.length, settings.maxExchangeLines ?? 3);
    if (!participants.includes(part.speakerId) || spoken >= limit) return [];
    spoken++;
    return [`${names.get(part.speakerId) ?? ''}: ${part.content}`];
  }).join('\n\n');
}

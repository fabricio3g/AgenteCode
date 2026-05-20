import type { RoleplayCharacter, RoleplayLorebook, RoleplayLorebookEntry, RoleplaySourceFormat } from '$lib/types/roleplay';

type UnknownRecord = Record<string, unknown>;

function createId(prefix: string) {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => text(entry)).filter(Boolean);
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {};
}

function decodeBase64(value: string): string {
  if (typeof atob === 'function') {
    return decodeURIComponent(Array.from(atob(value), (char) =>
      `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`
    ).join(''));
  }
  const bufferCtor = (globalThis as unknown as { Buffer?: { from: (value: string, encoding: string) => { toString: (encoding: string) => string } } }).Buffer;
  if (bufferCtor) return bufferCtor.from(value, 'base64').toString('utf8');
  throw new Error('Base64 decoding is not available in this environment.');
}

function normalizeEntries(entries: unknown, sourceCharacterId?: string | null): RoleplayLorebookEntry[] {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry, index) => {
    const item = record(entry);
    return {
      id: text(item.id) || createId('rp-lore-entry'),
      keys: stringArray(item.keys || item.key),
      secondaryKeys: stringArray(item.secondary_keys || item.secondaryKeys),
      content: text(item.content),
      comment: text(item.comment),
      enabled: item.enabled !== false && item.disable !== true,
      insertionOrder: Number.isFinite(item.insertion_order) ? Number(item.insertion_order) : index,
      constant: item.constant === true,
      sourceCharacterId: sourceCharacterId || null
    };
  }).filter((entry) => entry.content);
}

function normalizeLorebook(value: unknown, name: string, sourceCharacterId?: string | null): RoleplayLorebook | null {
  const book = record(value);
  const entries = normalizeEntries(book.entries, sourceCharacterId);
  if (!entries.length) return null;
  const now = Date.now();
  return {
    id: createId('rp-lorebook'),
    name: text(book.name) || name,
    entries,
    createdAt: now,
    updatedAt: now,
    sourceCharacterId: sourceCharacterId || null
  };
}

export function normalizeRoleplayCard(payload: unknown, options: {
  avatarDataUrl?: string;
  sourceFormat?: RoleplaySourceFormat;
} = {}): RoleplayCharacter {
  const root = record(payload);
  const isV2 = text(root.spec).toLowerCase() === 'chara_card_v2' || !!root.data;
  const data = isV2 ? record(root.data) : root;
  const now = Date.now();
  const sourceFormat = options.sourceFormat || (isV2 ? 'tavern-v2-json' : 'tavern-v1-json');

  const characterId = createId('rp-char');
  const tags = [
    ...stringArray(data.tags),
    ...stringArray(root.tags)
  ].filter((tag, index, all) => all.indexOf(tag) === index);

  const embeddedLorebook = normalizeLorebook(data.character_book || root.character_book, `${text(data.name) || 'Character'} lorebook`, characterId);

  return {
    id: characterId,
    name: text(data.name) || 'Imported character',
    description: text(data.description),
    personality: text(data.personality),
    scenario: text(data.scenario),
    firstMessage: text(data.first_mes || data.firstMessage || data.greeting),
    exampleDialogue: text(data.mes_example || data.exampleDialogue),
    creatorNotes: text(data.creator_notes || data.creatorNotes || data.notes),
    tags,
    avatarDataUrl: options.avatarDataUrl,
    sourceFormat,
    rawPayload: payload,
    embeddedLorebook,
    createdAt: now,
    updatedAt: now
  };
}

export function createBlankRoleplayCharacter(partial: Partial<RoleplayCharacter> = {}): RoleplayCharacter {
  const now = Date.now();
  return {
    id: partial.id || createId('rp-char'),
    name: partial.name || 'New character',
    description: partial.description || '',
    personality: partial.personality || '',
    scenario: partial.scenario || '',
    firstMessage: partial.firstMessage || '',
    exampleDialogue: partial.exampleDialogue || '',
    creatorNotes: partial.creatorNotes || '',
    tags: partial.tags || [],
    avatarDataUrl: partial.avatarDataUrl,
    sourceFormat: partial.sourceFormat || 'unknown-json',
    rawPayload: partial.rawPayload,
    embeddedLorebook: partial.embeddedLorebook || null,
    createdAt: partial.createdAt || now,
    updatedAt: partial.updatedAt || now
  };
}

export function parseRoleplayCardJson(raw: string): RoleplayCharacter {
  const payload = JSON.parse(raw);
  return normalizeRoleplayCard(payload);
}

export function extractPngCharaMetadata(bytes: Uint8Array): string {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 16 || !signature.every((value, index) => bytes[index] === value)) {
    throw new Error('Not a PNG file.');
  }

  let offset = 8;
  const decoder = new TextDecoder();
  while (offset + 12 <= bytes.length) {
    const length = ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
    const type = decoder.decode(bytes.slice(offset + 4, offset + 8));
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > bytes.length) break;

    if (type === 'tEXt') {
      const chunk = bytes.slice(dataStart, dataEnd);
      const nul = chunk.indexOf(0);
      if (nul >= 0) {
        const keyword = decoder.decode(chunk.slice(0, nul));
        if (keyword === 'chara') {
          const encoded = decoder.decode(chunk.slice(nul + 1));
          return decodeBase64(encoded);
        }
      }
    }
    offset = dataEnd + 4;
  }
  throw new Error('PNG does not contain Tavern chara metadata.');
}

export function parseRoleplayCardPng(bytes: Uint8Array, avatarDataUrl?: string): RoleplayCharacter {
  const rawJson = extractPngCharaMetadata(bytes);
  const payload = JSON.parse(rawJson);
  return normalizeRoleplayCard(payload, {
    avatarDataUrl,
    sourceFormat: 'tavern-png'
  });
}

export function resolveRoleplayTemplateVariables(value: string, args: { char?: string; user?: string }): string {
  return String(value || '')
    .replace(/\{\{char\}\}/gi, args.char || 'Character')
    .replace(/\{\{user\}\}/gi, args.user || 'User');
}

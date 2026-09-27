import type { CharacterAsset, CharacterBook, CharacterCard, LorebookEntry } from '$lib/types/chat';
import { createId } from '$lib/utils/id';

/**
 * Character card import.
 *
 * Accepts the community formats:
 * - Character Card V2/V3 JSON (`{ spec, data: {...} }`)
 * - V1 / flat JSON (fields at the root)
 * - PNG with a `chara` (or `ccv3`) tEXt/iTXt chunk — the format cards are
 *   shared in; the image itself becomes the avatar.
 *
 * CharX (.charx zip) is not supported yet.
 */

type UnknownRecord = Record<string, unknown>;

const str = (value: unknown): string => (typeof value === 'string' ? value : value == null ? '' : String(value));
const strArray = (value: unknown): string[] => (Array.isArray(value) ? value.map(str).filter(Boolean) : []);

export function emptyCharacter(overrides: Partial<CharacterCard> = {}): CharacterCard {
  const now = Date.now();
  return {
    id: createId('char'),
    name: '',
    nickname: '',
    tagline: '',
    avatar: '',
    description: '',
    personality: '',
    scenario: '',
    firstMessage: '',
    alternateGreetings: [],
    groupOnlyGreetings: [],
    exampleDialogue: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    creatorNotes: '',
    tags: [],
    creator: '',
    characterVersion: '1.0',
    spec: 'flaxeo',
    assets: [],
    book: null,
    voiceId: null,
    talkativeness: 50,
    temperature: null,
    topP: null,
    maxTokens: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

/** Fill in missing fields on persisted or imported cards without losing data. */
export function normalizeCharacterCard(card: Partial<CharacterCard>): CharacterCard {
  const base = emptyCharacter();
  return {
    ...base,
    ...card,
    id: String(card.id || base.id),
    name: String(card.name || ''),
    description: String(card.description || ''),
    personality: String(card.personality || ''),
    scenario: String(card.scenario || ''),
    firstMessage: String(card.firstMessage || ''),
    exampleDialogue: String(card.exampleDialogue || ''),
    systemPrompt: String(card.systemPrompt || ''),
    postHistoryInstructions: String(card.postHistoryInstructions || ''),
    alternateGreetings: Array.isArray(card.alternateGreetings) ? card.alternateGreetings.map(String) : [],
    groupOnlyGreetings: Array.isArray(card.groupOnlyGreetings) ? card.groupOnlyGreetings.map(String) : [],
    tags: Array.isArray(card.tags) ? card.tags.map(String) : [],
    assets: Array.isArray(card.assets) ? card.assets : [],
    createdAt: Number.isFinite(card.createdAt) ? Number(card.createdAt) : base.createdAt,
    updatedAt: Number.isFinite(card.updatedAt) ? Number(card.updatedAt) : base.updatedAt
  };
}

/** All greetings a 1:1 chat can start with: primary first, alternates after. */
export function greetingsFor(card: CharacterCard, options: { group?: boolean } = {}): string[] {
  const greetings = [card.firstMessage, ...(card.alternateGreetings || [])].filter((entry) => entry.trim());
  if (options.group) greetings.push(...(card.groupOnlyGreetings || []).filter((entry) => entry.trim()));
  return greetings;
}

/** A fresh lorebook entry with sensible defaults. */
export function emptyLoreEntry(overrides: Partial<LorebookEntry> = {}): LorebookEntry {
  return {
    id: createId('lore'),
    keys: [],
    secondaryKeys: [],
    selective: false,
    constant: false,
    content: '',
    enabled: true,
    insertionOrder: 100,
    caseSensitive: false,
    useRegex: false,
    comment: '',
    ...overrides
  };
}

/** Fill in missing fields on a lorebook stored in our own shape. */
export function normalizeBook(book: Partial<CharacterBook> | null | undefined): CharacterBook {
  const entries = Array.isArray(book?.entries)
    ? book.entries.map((entry, index) => {
        const base = emptyLoreEntry();
        return {
          ...base,
          ...entry,
          id: String(entry?.id || `entry-${index}`),
          keys: Array.isArray(entry?.keys) ? entry.keys.map(String) : [],
          secondaryKeys: Array.isArray(entry?.secondaryKeys) ? entry.secondaryKeys.map(String) : [],
          content: String(entry?.content || ''),
          enabled: entry?.enabled !== false,
          insertionOrder: Number.isFinite(entry?.insertionOrder) ? Number(entry.insertionOrder) : 100
        };
      })
    : [];
  return {
    name: String(book?.name || ''),
    description: String(book?.description || ''),
    scanDepth: Number.isFinite(book?.scanDepth) ? Number(book?.scanDepth) : 4,
    tokenBudget: Number.isFinite(book?.tokenBudget) ? Number(book?.tokenBudget) : 1024,
    recursiveScanning: !!book?.recursiveScanning,
    entries
  };
}

function mapBook(raw: unknown): CharacterBook | null {
  if (!raw || typeof raw !== 'object') return null;
  const book = raw as UnknownRecord;
  const entriesRaw = Array.isArray(book.entries) ? book.entries : [];
  const entries: LorebookEntry[] = entriesRaw.map((entry, index) => {
    const source = (entry && typeof entry === 'object' ? entry : {}) as UnknownRecord;
    const position = source.position === 'before_char' || source.position === 'after_char' ? source.position : undefined;
    return {
      id: str(source.id) || `entry-${index}`,
      keys: strArray(source.keys),
      secondaryKeys: strArray(source.secondary_keys),
      selective: !!source.selective,
      secondaryLogic: ['and_any', 'and_all', 'not_any', 'not_all'].includes(String(source.secondary_logic))
        ? (source.secondary_logic as LorebookEntry['secondaryLogic'])
        : undefined,
      constant: !!source.constant,
      content: str(source.content),
      enabled: source.enabled !== false,
      insertionOrder: typeof source.insertion_order === 'number' ? source.insertion_order : index,
      caseSensitive: !!source.case_sensitive,
      useRegex: !!source.use_regex,
      priority: typeof source.priority === 'number' ? source.priority : undefined,
      position,
      comment: str(source.comment) || undefined
    };
  });
  return {
    name: str(book.name) || undefined,
    description: str(book.description) || undefined,
    scanDepth: typeof book.scan_depth === 'number' ? book.scan_depth : undefined,
    tokenBudget: typeof book.token_budget === 'number' ? book.token_budget : undefined,
    recursiveScanning: !!book.recursive_scanning,
    entries
  };
}

function mapAssets(raw: unknown): CharacterAsset[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((asset) => {
    if (!asset || typeof asset !== 'object') return [];
    const source = asset as UnknownRecord;
    const uri = str(source.uri);
    const type = str(source.type);
    if (!uri || !type) return [];
    return [{ type, uri, name: str(source.name) || undefined, ext: str(source.ext) || undefined }];
  });
}

/** Map a card `data` block (V2/V3) or a flat V1 object onto our card fields. */
export function mapCardFields(raw: UnknownRecord): Partial<CharacterCard> {
  return {
    name: str(raw.name),
    nickname: str(raw.nickname) || undefined,
    description: str(raw.description),
    personality: str(raw.personality),
    scenario: str(raw.scenario),
    firstMessage: str(raw.first_mes),
    alternateGreetings: strArray(raw.alternate_greetings),
    groupOnlyGreetings: strArray(raw.group_only_greetings),
    exampleDialogue: str(raw.mes_example),
    systemPrompt: str(raw.system_prompt),
    postHistoryInstructions: str(raw.post_history_instructions),
    creatorNotes: str(raw.creator_notes) || undefined,
    tags: strArray(raw.tags),
    creator: str(raw.creator) || undefined,
    characterVersion: str(raw.character_version) || undefined,
    assets: mapAssets(raw.assets),
    book: mapBook(raw.character_book)
  };
}

export function parseCharacterCardJson(raw: string): CharacterCard {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('This file is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('This file does not contain a character card.');
  }

  const object = parsed as UnknownRecord;
  const spec = str(object.spec);
  const nested = object.data && typeof object.data === 'object' && !Array.isArray(object.data)
    ? object.data as UnknownRecord
    : null;

  let data: UnknownRecord;
  let specTag: CharacterCard['spec'];
  if (spec.startsWith('chara_card_v3') && nested) {
    data = nested;
    specTag = 'chara_card_v3';
  } else if (spec.startsWith('chara_card_v2') && nested) {
    data = nested;
    specTag = 'chara_card_v2';
  } else if (nested && str(nested.name)) {
    data = nested;
    specTag = 'flaxeo';
  } else {
    data = object;
    specTag = 'flaxeo';
  }

  const name = str(data.name).trim();
  if (!name) throw new Error('The card has no character name.');

  return normalizeCharacterCard({ ...mapCardFields(data), spec: specTag, id: createId('char') });
}

// ── PNG tEXt / iTXt extraction ─────────────────────────────────────────

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CARD_KEYWORDS = new Set(['chara', 'ccv3']);

function hasPngSignature(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

function latin1(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

function indexOfByte(bytes: Uint8Array, needle: number, from: number): number {
  for (let index = from; index < bytes.length; index += 1) {
    if (bytes[index] === needle) return index;
  }
  return -1;
}

async function inflateZlib(bytes: Uint8Array): Promise<string> {
  if (typeof DecompressionStream === 'undefined') return '';
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Response(stream).text();
}

async function decodeTextChunk(type: string, chunk: Uint8Array): Promise<string | null> {
  const separator = indexOfByte(chunk, 0, 0);
  if (separator < 0) return null;
  const keyword = latin1(chunk.subarray(0, separator));
  if (!CARD_KEYWORDS.has(keyword)) return null;

  if (type === 'tEXt') {
    return latin1(chunk.subarray(separator + 1));
  }

  // iTXt: keyword \0 compressionFlag compressionMethod languageTag \0 translated \0 text
  let cursor = separator + 1;
  const compressionFlag = chunk[cursor];
  cursor += 2;
  const languageEnd = indexOfByte(chunk, 0, cursor);
  if (languageEnd < 0) return null;
  cursor = languageEnd + 1;
  const translatedEnd = indexOfByte(chunk, 0, cursor);
  if (translatedEnd < 0) return null;
  cursor = translatedEnd + 1;
  const text = chunk.subarray(cursor);
  return compressionFlag === 1 ? inflateZlib(text) : new TextDecoder().decode(text);
}

/** Pull the embedded card payload (base64 or raw JSON) out of a PNG. */
export async function extractCardPayloadFromPng(bytes: Uint8Array): Promise<string | null> {
  if (!hasPngSignature(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;

  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = latin1(bytes.subarray(offset + 4, offset + 8));
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > bytes.length) break;

    if (type === 'tEXt' || type === 'iTXt') {
      const payload = await decodeTextChunk(type, bytes.subarray(dataStart, dataEnd));
      if (payload) return payload;
    }
    if (type === 'IEND') break;
    offset = dataEnd + 4; // skip CRC
  }
  return null;
}

/** Card payloads are base64-encoded JSON; tolerate raw JSON too. */
export function decodeCardPayload(payload: string): string {
  const trimmed = payload.trim();
  if (trimmed.startsWith('{')) return trimmed;
  try {
    const binary = atob(trimmed);
    const decoded = new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
    if (decoded.trim().startsWith('{')) return decoded;
  } catch {
    // fall through — the error below explains the format
  }
  throw new Error('The character data in this image is not readable.');
}

export async function parseCharacterCardPng(bytes: Uint8Array): Promise<CharacterCard> {
  const payload = await extractCardPayloadFromPng(bytes);
  if (!payload) throw new Error('No character data found in this PNG.');
  return parseCharacterCardJson(decodeCardPayload(payload));
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read the image.'));
    reader.readAsDataURL(file);
  });
}

/** Parse an imported .json or .png card. PNGs also become the avatar. */
export async function parseCharacterCardFile(file: File): Promise<CharacterCard> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.png') || file.type === 'image/png') {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const card = await parseCharacterCardPng(bytes);
    if (bytes.length <= 2 * 1024 * 1024) {
      card.avatar = await fileToDataUrl(file);
    }
    return card;
  }
  if (name.endsWith('.json') || file.type.includes('json')) {
    return parseCharacterCardJson(await file.text());
  }
  throw new Error('Import a character card as .json or .png.');
}

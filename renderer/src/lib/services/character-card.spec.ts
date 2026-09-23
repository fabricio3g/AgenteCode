import { describe, expect, it } from 'vitest';
import {
  decodeCardPayload,
  extractCardPayloadFromPng,
  parseCharacterCardJson,
  parseCharacterCardPng
} from '$lib/services/character-card';

const V2_CARD = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Aiko',
    description: '{{char}} is a barista.',
    personality: 'Sarcastic.',
    scenario: '{{user}} arrives late.',
    first_mes: '"You again?"',
    alternate_greetings: ['"Late again?"'],
    mes_example: '<START>\n{{user}}: Hi\n{{char}}: Hey.',
    system_prompt: '',
    post_history_instructions: 'Keep it short.',
    tags: ['slice-of-life'],
    creator: 'Sam',
    character_version: '1.2',
    character_book: {
      name: 'Cafe lore',
      scan_depth: 4,
      token_budget: 500,
      entries: [
        {
          keys: ['midnight'],
          content: 'The cafe closes at midnight.',
          enabled: true,
          insertion_order: 10,
          position: 'before_char'
        }
      ]
    }
  }
};

function pngWithText(keyword: string, text: string): Uint8Array {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const keywordBytes = Array.from(keyword, (char) => char.charCodeAt(0));
  const textBytes = Array.from(text, (char) => char.charCodeAt(0));
  const data = new Uint8Array([...keywordBytes, 0, ...textBytes]);

  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set([0x74, 0x45, 0x58, 0x74], 4); // tEXt
  chunk.set(data, 8);
  // CRC bytes stay zero — the parser does not validate them.

  const iend = new Uint8Array(12);
  new DataView(iend.buffer).setUint32(0, 0);
  iend.set([0x49, 0x45, 0x4e, 0x44], 4);

  return new Uint8Array([...signature, ...chunk, ...iend]);
}

describe('parseCharacterCardJson', () => {
  it('maps a V2 card, including lorebook and metadata', () => {
    const card = parseCharacterCardJson(JSON.stringify(V2_CARD));
    expect(card.name).toBe('Aiko');
    expect(card.spec).toBe('chara_card_v2');
    expect(card.firstMessage).toBe('"You again?"');
    expect(card.alternateGreetings).toEqual(['"Late again?"']);
    expect(card.tags).toEqual(['slice-of-life']);
    expect(card.creator).toBe('Sam');
    expect(card.characterVersion).toBe('1.2');
    expect(card.book?.entries[0]?.keys).toEqual(['midnight']);
    expect(card.book?.entries[0]?.position).toBe('before_char');
    expect(card.book?.tokenBudget).toBe(500);
    expect(card.id).toMatch(/^char/);
  });

  it('maps a flat V1 card', () => {
    const card = parseCharacterCardJson(JSON.stringify({
      name: 'Ren',
      description: 'A pilot.',
      first_mes: 'Ready?'
    }));
    expect(card.name).toBe('Ren');
    expect(card.firstMessage).toBe('Ready?');
    expect(card.spec).toBe('flaxeo');
  });

  it('rejects invalid JSON, non-objects and nameless cards', () => {
    expect(() => parseCharacterCardJson('not json')).toThrow(/valid JSON/);
    expect(() => parseCharacterCardJson('[1,2]')).toThrow(/character card/);
    expect(() => parseCharacterCardJson(JSON.stringify({ description: 'no name' }))).toThrow(/name/);
  });
});

describe('decodeCardPayload', () => {
  it('accepts base64 and raw JSON', () => {
    const json = JSON.stringify({ name: 'Aiko' });
    expect(decodeCardPayload(btoa(json))).toBe(json);
    expect(decodeCardPayload(json)).toBe(json);
  });
});

describe('PNG card extraction', () => {
  it('reads a chara tEXt chunk', async () => {
    const payload = btoa(JSON.stringify(V2_CARD));
    const bytes = pngWithText('chara', payload);
    expect(await extractCardPayloadFromPng(bytes)).toBe(payload);

    const card = await parseCharacterCardPng(bytes);
    expect(card.name).toBe('Aiko');
  });

  it('ignores images without card data', async () => {
    const bytes = pngWithText('Comment', 'just a photo');
    expect(await extractCardPayloadFromPng(bytes)).toBeNull();
    await expect(parseCharacterCardPng(bytes)).rejects.toThrow(/No character data/);
  });

  it('returns null for non-PNG bytes', async () => {
    expect(await extractCardPayloadFromPng(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

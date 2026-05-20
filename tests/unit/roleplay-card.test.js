import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  extractPngCharaMetadata,
  normalizeRoleplayCard,
  parseRoleplayCardJson,
  parseRoleplayCardPng,
  resolveRoleplayTemplateVariables
} from '../../renderer/src/lib/services/roleplay-card.ts';

function chunk(type, data) {
  const body = Buffer.from(data);
  const result = Buffer.alloc(8 + body.length + 4);
  result.writeUInt32BE(body.length, 0);
  result.write(type, 4, 4, 'ascii');
  body.copy(result, 8);
  return result;
}

function pngWithChara(payload) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return new Uint8Array(Buffer.concat([
    signature,
    chunk('tEXt', Buffer.concat([Buffer.from('chara\0', 'ascii'), Buffer.from(encoded, 'utf8')])),
    chunk('IEND', Buffer.alloc(0))
  ]));
}

describe('roleplay card parsing', () => {
  it('normalizes Tavern V2 JSON and embedded character books', () => {
    const character = parseRoleplayCardJson(JSON.stringify({
      spec: 'chara_card_v2',
      data: {
        name: 'Ada',
        description: 'A scholar who knows {{user}}.',
        personality: 'Curious',
        scenario: 'In a library',
        first_mes: 'Hello, {{user}}.',
        mes_example: '{{char}}: Welcome.',
        tags: ['mentor'],
        character_book: {
          entries: [
            { keys: ['library'], content: 'The library is sentient.', enabled: true }
          ]
        }
      }
    }));

    assert.equal(character.sourceFormat, 'tavern-v2-json');
    assert.equal(character.name, 'Ada');
    assert.equal(character.firstMessage, 'Hello, {{user}}.');
    assert.deepEqual(character.tags, ['mentor']);
    assert.equal(character.embeddedLorebook?.entries.length, 1);
    assert.equal(character.embeddedLorebook?.entries[0].keys[0], 'library');
  });

  it('accepts flat V1-like JSON cards', () => {
    const character = normalizeRoleplayCard({
      name: 'Mira',
      description: 'Flat card',
      first_mes: 'Hi'
    });

    assert.equal(character.sourceFormat, 'tavern-v1-json');
    assert.equal(character.name, 'Mira');
    assert.equal(character.firstMessage, 'Hi');
  });

  it('extracts and normalizes PNG chara metadata', () => {
    const payload = {
      spec: 'chara_card_v2',
      data: { name: 'Png Hero', description: 'Embedded' }
    };
    const bytes = pngWithChara(payload);

    assert.equal(JSON.parse(extractPngCharaMetadata(bytes)).data.name, 'Png Hero');
    const character = parseRoleplayCardPng(bytes, 'data:image/png;base64,avatar');
    assert.equal(character.sourceFormat, 'tavern-png');
    assert.equal(character.avatarDataUrl, 'data:image/png;base64,avatar');
  });

  it('resolves common roleplay template variables', () => {
    assert.equal(
      resolveRoleplayTemplateVariables('{{char}} greets {{user}}.', { char: 'Ada', user: 'Sam' }),
      'Ada greets Sam.'
    );
  });
});

import { describe, expect, it } from 'vitest';
import {
  MAX_PROPS_PER_REPLY,
  extractRoleplayProps,
  normalizePropKind,
  stripRoleplayPropBlock
} from './roleplay-props';

describe('normalizePropKind', () => {
  it('accepts the known kinds and falls back to object', () => {
    expect(normalizePropKind('letter')).toBe('letter');
    expect(normalizePropKind('  MAP  ')).toBe('map');
    expect(normalizePropKind('treasure')).toBe('object');
    expect(normalizePropKind('')).toBe('object');
  });
});

describe('extractRoleplayProps', () => {
  it('pulls a labelled block out of the prose', () => {
    const result = extractRoleplayProps(
      '*She slides the envelope across.*\n\n[prop]\ntitle: A letter, sealed\nkind: letter\nbody: Come alone.\n[/prop]\n\n"Read it later."'
    );
    expect(result.props).toEqual([{ title: 'A letter, sealed', kind: 'letter', body: 'Come alone.' }]);
    expect(result.text).toContain('*She slides the envelope across.*');
    expect(result.text).toContain('"Read it later."');
    expect(result.text).not.toContain('[prop]');
  });

  it('keeps prose that sits before and after the block', () => {
    const result = extractRoleplayProps('Before.\n[prop]\ntitle: Key\nbody: Brass.\n[/prop]\nAfter.');
    expect(result.text).toBe('Before.\nAfter.');
  });

  it('reads an unlabelled block as title then body', () => {
    const result = extractRoleplayProps('[prop]\nA torn page\nThe ink is still wet.\nMore of it here.\n[/prop]');
    expect(result.props[0]?.title).toBe('A torn page');
    expect(result.props[0]?.body).toBe('The ink is still wet.\nMore of it here.');
    expect(result.props[0]?.kind).toBe('object');
  });

  it('survives a dropped closing tag', () => {
    const result = extractRoleplayProps('[prop]\ntitle: A note\nbody: Midnight.\n');
    expect(result.props).toEqual([{ title: 'A note', kind: 'object', body: 'Midnight.' }]);
    expect(result.text).toBe('');
  });

  it('tolerates headings, bold and numbering', () => {
    const result = extractRoleplayProps('### prop\n**title**: Map of the cellars\n1. body: Three exits marked\n');
    expect(result.props[0]?.title).toBe('Map of the cellars');
    expect(result.props[0]?.body).toBe('Three exits marked');
    expect(result.props[0]?.kind).toBe('object');
  });

  it('caps how many props one reply can hand over', () => {
    const blocks = Array.from({ length: 6 }, (_, index) => `[prop]\ntitle: Item ${index}\nbody: x\n[/prop]`).join('\n');
    expect(extractRoleplayProps(blocks).props).toHaveLength(MAX_PROPS_PER_REPLY);
  });

  it('ignores empty blocks and stray prose', () => {
    expect(extractRoleplayProps('[prop]\n[/prop]').props).toEqual([]);
    expect(extractRoleplayProps('Just talking.').props).toEqual([]);
    expect(extractRoleplayProps('').text).toBe('');
  });
});

describe('stripRoleplayPropBlock', () => {
  it('hides a closed block', () => {
    const text = 'She hands it over.\n[prop]\ntitle: Key\nbody: Brass.\n[/prop]\nHe pockets it.';
    expect(stripRoleplayPropBlock(text)).toBe('She hands it over.\nHe pockets it.');
  });

  it('leaves an open block visible — a prop sits mid-reply, so swallowing it would eat the prose after it', () => {
    const streaming = 'She hands it over.\n[prop]\ntitle: Key\n';
    expect(stripRoleplayPropBlock(streaming)).toBe(streaming);
  });

  it('is a no-op on plain prose', () => {
    expect(stripRoleplayPropBlock('*She smiles.*\nSomeone knocks.')).toBe('*She smiles.*\nSomeone knocks.');
    expect(stripRoleplayPropBlock('')).toBe('');
  });
});

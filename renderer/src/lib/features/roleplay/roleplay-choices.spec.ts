import { describe, expect, it } from 'vitest';
import { extractRoleplayChoices, stripRoleplayChoiceBlock } from './roleplay-choices';

describe('extractRoleplayChoices', () => {
  it('parses a fenced block and removes it from the text', () => {
    const { text, choices } = extractRoleplayChoices(
      'The alley narrows ahead.\n\n[choices]\n- Step forward\n- Turn back\n[/choices]'
    );
    expect(choices).toEqual(['Step forward', 'Turn back']);
    expect(text).toBe('The alley narrows ahead.');
  });

  it('tolerates a missing closing tag', () => {
    const { text, choices } = extractRoleplayChoices('Rain falls.\n[choices]\n1. Wait\n2) Run');
    expect(choices).toEqual(['Wait', 'Run']);
    expect(text).toBe('Rain falls.');
  });

  it('tolerates headings, bold and bullets', () => {
    const { choices } = extractRoleplayChoices('Scene.\n### Choices\n* **Ask about the letter**\n• Leave');
    expect(choices).toEqual(['Ask about the letter', 'Leave']);
  });

  it('returns nothing for ordinary prose', () => {
    const { text, choices } = extractRoleplayChoices('Just a reply.');
    expect(choices).toEqual([]);
    expect(text).toBe('Just a reply.');
  });

  it('ignores an empty block', () => {
    const { choices } = extractRoleplayChoices('Text.\n[choices]\n[/choices]');
    expect(choices).toEqual([]);
  });

  it('caps the option count', () => {
    const body = Array.from({ length: 9 }, (_, index) => `- Option ${index + 1}`).join('\n');
    expect(extractRoleplayChoices(`[choices]\n${body}\n[/choices]`).choices).toHaveLength(6);
  });
});

describe('stripRoleplayChoiceBlock', () => {
  it('hides a streaming block', () => {
    expect(stripRoleplayChoiceBlock('Text.\n[choices]\n- One')).toBe('Text.');
  });

  it('leaves text without a block alone', () => {
    expect(stripRoleplayChoiceBlock('Text.')).toBe('Text.');
  });
});

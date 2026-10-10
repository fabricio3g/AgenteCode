import { describe, expect, it } from 'vitest';
import { parseExchanges, serializeExchanges } from './example-dialogue';

describe('example dialogue as sample exchanges', () => {
  const card = '<START>\n{{user}}: Rough day?\n{{char}}: "Define rough."\n<START>\n{{user}}: Hi\nstill here\n{{char}}: Hello.';

  it('reads each <START> block as one exchange with speakers', () => {
    const exchanges = parseExchanges(card);
    expect(exchanges).toHaveLength(2);
    expect(exchanges[0].lines).toEqual([
      { speaker: 'user', text: 'Rough day?' },
      { speaker: 'char', text: '"Define rough."' }
    ]);
    expect(exchanges[1].lines[0]).toEqual({ speaker: 'user', text: 'Hi\nstill here' });
  });

  it('round-trips through the card format', () => {
    expect(serializeExchanges(parseExchanges(card))).toBe(
      '<START>\n{{user}}: Rough day?\n{{char}}: "Define rough."\n<START>\n{{user}}: Hi\nstill here\n{{char}}: Hello.'
    );
  });

  it('keeps a literal name as its own speaker and drops blank lines on write', () => {
    const exchanges = parseExchanges('<START>\nMira: Come in.\n{{user}}:   ');
    expect(exchanges[0].lines[0].speaker).toBe('name:Mira');
    expect(serializeExchanges(exchanges)).toBe('<START>\nMira: Come in.');
  });

  it('treats text without a block marker as one exchange, and empty text as none', () => {
    expect(parseExchanges('{{char}}: Hi')).toHaveLength(1);
    expect(parseExchanges('  ')).toEqual([]);
    expect(serializeExchanges([])).toBe('');
  });
});

import { describe, expect, it } from 'vitest';
import { completionAt, matchNames, replaceCompletion } from './name-completion';

describe('room name completion', () => {
  it('matches full names, Unicode, aliases and partial names at the caret', () => {
    const candidates = [{ id: 'a', name: 'Élodie Voss', aliases: ['Lodie'] }, { id: 'b', name: '小雪' }];
    expect(completionAt('Ask @Élodie V', 13)?.query).toBe('Élodie V');
    expect(matchNames(candidates, 'élodie v')[0].id).toBe('a');
    expect(matchNames(candidates, 'lod')[0].id).toBe('a');
    expect(matchNames(candidates, '小')[0].id).toBe('b');
    expect(completionAt('Ask Él', 6, true)?.query).toBe('Él');
    expect(completionAt('Ask Él', 6)).toBeNull();
  });
  it('inserts at a middle cursor without replacing surrounding draft text', () => {
    const text = 'Ask @Wr about the gate.';
    const range = completionAt(text, 7)!;
    const inserted = replaceCompletion(text, range, '@Wren');
    expect(inserted).toEqual({ text: 'Ask @Wren about the gate.', caret: 10 });
    const middle = 'Ask @Wren about the gate.';
    expect(replaceCompletion(middle, completionAt(middle, 7)!, '@Wray').text).toBe('Ask @Wray about the gate.');
    expect(matchNames([{ id: 'a', name: 'Ren' }, { id: 'b', name: 'Ren' }], 're').map((candidate) => candidate.id)).toEqual(['a', 'b']);
  });
});

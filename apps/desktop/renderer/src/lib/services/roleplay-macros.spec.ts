import { describe, expect, it } from 'vitest';
import { resolveMacros, type MacroContext } from './roleplay-macros';

/** A fixed instant (local time), so time macros are checked against a known moment. */
const AT = new Date(2026, 0, 2, 9, 5);

const base: MacroContext = { char: 'Aiko', user: 'Sam', now: AT, seed: 'msg-1' };

/** A random source that always returns `value`. */
const fixed = (value: number) => () => value;

describe('resolveMacros: names', () => {
  it('leaves text without macros exactly as it is', () => {
    expect(resolveMacros('Just prose, no macros.', base)).toBe('Just prose, no macros.');
    expect(resolveMacros('', base)).toBe('');
  });

  it('resolves char, user, persona and nickname in any case, with optional spaces', () => {
    expect(resolveMacros('{{char}} meets {{user}}', base)).toBe('Aiko meets Sam');
    expect(resolveMacros('{{CHAR}}/{{ Persona }}/{{nickname}}/{{ USER }}', base)).toBe('Aiko/Sam/Sam/Sam');
  });

  it('lists the scene for group and gives charIfNotGroup only outside a group', () => {
    expect(resolveMacros('{{group}}', { ...base, group: ['Aiko', 'Ren'] })).toBe('Aiko, Ren');
    expect(resolveMacros('{{group}}', base)).toBe('Aiko');
    expect(resolveMacros('Hi, I am {{charIfNotGroup}}.', base)).toBe('Hi, I am Aiko.');
    expect(resolveMacros('[{{charIfNotGroup}}]', { ...base, group: ['Aiko', 'Ren'] })).toBe('[]');
    expect(resolveMacros('{{charIfNotGroup}}', { ...base, group: ['Aiko', 'Ren'], charIfNotGroup: 'the house' })).toBe('the house');
  });

  it('accepts the legacy Tavern tokens, in any case', () => {
    expect(resolveMacros('<USER> and <bot> meet <CHAR>', base)).toBe('Sam and Aiko meet Aiko');
  });
});

describe('resolveMacros: time', () => {
  it('reads the instant it is given, not the wall clock', () => {
    const weekday = AT.toLocaleDateString(undefined, { weekday: 'long' });
    const date = AT.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    const time = AT.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    expect(resolveMacros('{{time}}', base)).toBe(time);
    expect(resolveMacros('{{date}}', base)).toBe(date);
    expect(resolveMacros('{{weekday}}', base)).toBe(weekday);
    expect(resolveMacros('{{isotime}}', base)).toBe('09:05');
    expect(resolveMacros('{{isodate}}', base)).toBe('2026-01-02');
  });
});

describe('resolveMacros: random, pick and roll', () => {
  it('random picks one option with the random source, in both forms', () => {
    expect(resolveMacros('{{random::a::b::c}}', { ...base, rng: fixed(0) })).toBe('a');
    expect(resolveMacros('{{random::a::b::c}}', { ...base, rng: fixed(0.99) })).toBe('c');
    expect(resolveMacros('{{random:x,y}}', { ...base, rng: fixed(0.6) })).toBe('y');
  });

  it('keeps the same pick for the same seed and text', () => {
    const text = '{{random::a::b::c::d::e}} {{pick::a::b::c::d::e}} {{roll::1d20}}';
    expect(resolveMacros(text, base)).toBe(resolveMacros(text, base));
  });

  it('spreads picks across seeds, so a seed is not a constant', () => {
    const picks = new Set<string>();
    for (let index = 0; index < 40; index += 1) {
      picks.add(resolveMacros('{{pick::a::b::c::d}}', { ...base, seed: `seed-${index}` }));
    }
    expect(picks.size).toBeGreaterThan(1);
  });

  it('pick draws from the text seed, independent of other macros in the same text', () => {
    const alone = resolveMacros('{{pick::a::b::c}}', base);
    const withOthers = resolveMacros('{{random::x::y}} {{pick::a::b::c}}', base).split(' ')[1];
    expect(withOthers).toBe(alone);
  });

  it('roll sums dice notation, with an optional modifier', () => {
    expect(resolveMacros('{{roll::1d20}}', { ...base, rng: fixed(0) })).toBe('1');
    expect(resolveMacros('{{roll::1d20}}', { ...base, rng: fixed(0.999) })).toBe('20');
    expect(resolveMacros('{{roll:2d6+3}}', { ...base, rng: fixed(0.5) })).toBe('11');
    expect(resolveMacros('{{roll:d6}}', { ...base, rng: fixed(0) })).toBe('1');
  });

  it('leaves a malformed roll as written', () => {
    expect(resolveMacros('{{roll::banana}}', base)).toBe('{{roll::banana}}');
    expect(resolveMacros('{{roll::0d6}}', base)).toBe('{{roll::0d6}}');
  });
});

describe('resolveMacros: control macros', () => {
  it('turns newline into a line break and noop into nothing', () => {
    expect(resolveMacros('A{{newline}}B', base)).toBe('A\nB');
    expect(resolveMacros('A{{noop}}B', base)).toBe('AB');
  });

  it('trims the newlines around trim', () => {
    expect(resolveMacros('Hello\n{{trim}}\nworld', base)).toBe('Helloworld');
    expect(resolveMacros('A\n\n{{trim}}\nB', base)).toBe('AB');
  });

  it('removes comments', () => {
    expect(resolveMacros('A{{// note to self: {{user}} }}B', base)).toBe('AB');
  });

  it('resolves lastMessage and original only when the context supplies them', () => {
    expect(resolveMacros('{{lastMessage}}', base)).toBe('{{lastMessage}}');
    expect(resolveMacros('{{lastMessage}}', { ...base, lastMessage: 'Hi.' })).toBe('Hi.');
    expect(resolveMacros('{{original}}', base)).toBe('{{original}}');
    expect(resolveMacros('{{original}} + more', { ...base, original: 'Default.' })).toBe('Default. + more');
  });

  it('does not resolve a supplied value a second time', () => {
    expect(resolveMacros('{{lastMessage}}', { ...base, lastMessage: '{{user}}' })).toBe('{{user}}');
  });
});

describe('resolveMacros: unknown macros and nesting', () => {
  it('leaves unknown and malformed macros exactly as written', () => {
    const text = '{{foo}} {{char name}} {{}} {{char::x}} {{random}} {{roll}} {{ }} {{char';
    expect(resolveMacros(text, base)).toBe(text);
  });

  it('resolves nested macros inside-out', () => {
    expect(resolveMacros('{{random::{{char}}::{{user}}}}', { ...base, rng: fixed(0.99) })).toBe('Sam');
    expect(resolveMacros('{{random::{{random::x::y}}::z}}', { ...base, rng: fixed(0) })).toBe('x');
  });

  it('keeps an unknown macro inside a known one as written', () => {
    expect(resolveMacros('{{random::{{foo}}::b}}', { ...base, rng: fixed(0) })).toBe('{{foo}}');
  });

  it('resolves the names inside an unknown macro, keeping the macro itself', () => {
    expect(resolveMacros('{{weird {{user}} }}', base)).toBe('{{weird Sam }}');
  });
});

describe('resolveMacros: stability', () => {
  it('gives the same output for the same text, context and seed', () => {
    const text = 'Dice: {{roll::2d10}}. Pick: {{random::red::green::blue}}. Stamp: {{isodate}}.';
    expect(resolveMacros(text, base)).toBe(resolveMacros(text, base));
  });

  it('follows the seed for random draws', () => {
    const text = '{{random::1::2::3::4::5::6::7::8}}';
    const first = resolveMacros(text, { ...base, seed: 'a' });
    const second = resolveMacros(text, { ...base, seed: 'a' });
    expect(first).toBe(second);
  });
});

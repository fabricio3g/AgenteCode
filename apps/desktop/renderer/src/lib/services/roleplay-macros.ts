/**
 * Roleplay macros: the one resolver for every `{{…}}` a scene carries.
 *
 * Policy. Text is stored raw and resolved at the edge, against the context it
 * is shown or sent in:
 *
 * - Storage. Messages (yours and the model's), greetings, cards, worlds,
 *   personas, journal entries, props, choices and the author's note keep their
 *   macros as typed. Nothing persists resolved text, so renaming a persona or a
 *   character re-resolves everything already written.
 * - Display. A message resolves for itself: {{char}} is its speaker (a line you
 *   wrote is spoken to whoever answered it), {{user}} is the chat's active persona
 *   now, time macros read the message's createdAt, and random, pick and roll seed
 *   from the message id. Copy, export, TTS and previews show the same text.
 * - The model. History resolves per message the same way, so the model reads the
 *   names the viewer reads. {{user}} is the turn's persona: a regenerate keeps the
 *   name its prompt was built with.
 * - The system prompt is byte-stable across turns, for prefix caching. It resolves
 *   against the chat: time macros report the chat's start, and random, pick and
 *   roll are seeded by the chat id, so they never change between turns.
 *   {{lastMessage}} is the one macro that follows the chat by definition; a card
 *   that uses it changes its system text on every turn.
 * - Model output may echo macros ("{{user}}: …"). The reply is stored raw and
 *   resolves on display like any other message.
 *
 * Resolution is pure: the same text and context give the same result, and the
 * wall clock is only read when a caller leaves `now` out. An unknown macro is
 * left exactly as written, so a typo shows up instead of silently vanishing.
 */

/** What a macro resolves against. `char` and `user` are always present. */
export interface MacroContext {
  /** {{char}}: the character speaking, or being spoken to. */
  char: string;
  /** {{user}}, {{persona}} and {{nickname}}: the user's persona name. */
  user: string;
  /** Scene members in roster order, for {{group}}. Defaults to `char` alone. */
  group?: string[];
  /** {{charIfNotGroup}} override. Otherwise `char` in a one-character scene, empty in a group. */
  charIfNotGroup?: string;
  /** {{original}}: the default text a card's override replaces. Left as written when absent. */
  original?: string;
  /** {{lastMessage}}: the previous finished message, already resolved. Left as written when absent. */
  lastMessage?: string;
  /** The instant time macros report. Defaults to the wall clock. */
  now?: Date;
  /** Key for random, pick and roll: the same key and text always resolve the same way. */
  seed?: string;
  /** Random source in [0, 1), for tests. Overrides `seed`. */
  rng?: () => number;
}

/** Tavern-era tokens: plain names, so they resolve before any macro. */
const LEGACY = /<(user|bot|char)>/i;
const LEGACY_ALL = /<(user|bot|char)>/gi;
/** The innermost macro: `{{…}}` holding no other braces, so nesting resolves inside-out. */
const INNERMOST = /\{\{((?:(?!\{\{|\}\})[\s\S])*)\}\}/g;
/** A resolved value parked in a slot, so later passes never re-read it. */
const SLOT = /\u0000(\d+)\u0000/g;
/** Marks `{{trim}}`, which removes the newlines around it once the text is assembled. */
const TRIM = '\u0003';
const MAX_NESTING = 8;
const MAX_DICE = 100;
const MAX_SIDES = 1000;
const DICE = /^(\d*)d(\d+)([+-]\d+)?$/i;

/** FNV-1a: a 32-bit hash that means the same thing in every session. */
function hashSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32: a small seeded generator, uniform in [0, 1). */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (value: number) => String(value).padStart(2, '0');

/** The options of `::a::b` or the legacy `:a,b`; undefined when the form is neither. */
function optionsOf(rest: string): string[] | undefined {
  if (rest.startsWith('::')) return rest.slice(2).split('::').map((option) => option.trim());
  if (rest.startsWith(':')) return rest.slice(1).split(',').map((option) => option.trim());
  return undefined;
}

/**
 * Resolve every macro in `text` against `ctx`.
 *
 * Nested macros resolve inside-out, so `{{random::{{char}}::{{user}}}}` picks
 * between the names. Supported: {{char}}, {{user}}, {{persona}}, {{nickname}},
 * {{group}}, {{charIfNotGroup}}, {{time}}, {{date}}, {{weekday}}, {{isotime}},
 * {{isodate}}, {{random::a::b}} (or {{random:a,b}}), {{pick::…}}, {{roll::2d6+1}}
 * (or {{roll:d20}}), {{newline}}, {{trim}}, {{// comment}}, {{noop}},
 * {{lastMessage}}, {{original}} and the legacy <USER>, <BOT>, <CHAR>. Macro names
 * are case-insensitive and may be padded with spaces.
 */
export function resolveMacros(text: string, ctx: MacroContext): string {
  if (!text || (!text.includes('{{') && !LEGACY.test(text))) return text;

  const now = ctx.now ?? new Date();
  const draw: () => number = ctx.rng ?? (ctx.seed === undefined ? Math.random : seeded(hashSeed(ctx.seed)));
  // Random picks by key are independent of how many other macros the text has.
  const keyed = (key: string) => (ctx.rng ? ctx.rng() : ctx.seed === undefined ? Math.random() : seeded(hashSeed(`${ctx.seed}\u0001${key}`))());

  const slots: string[] = [];
  const hold = (value: string) => `\u0000${slots.push(value) - 1}\u0000`;
  const unhold = (value: string) => value.replace(SLOT, (_match, index: string) => slots[Number(index)] ?? '');

  const plain = (name: string): string | undefined => {
    switch (name) {
      case 'char':
        return ctx.char;
      case 'user':
      case 'persona':
      case 'nickname':
        return ctx.user;
      case 'group':
        return (ctx.group?.length ? ctx.group : [ctx.char]).join(', ');
      case 'charifnotgroup':
        return ctx.charIfNotGroup ?? (ctx.group && ctx.group.length > 1 ? '' : ctx.char);
      case 'time':
        return now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      case 'date':
        return now.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
      case 'weekday':
        return now.toLocaleDateString(undefined, { weekday: 'long' });
      case 'isotime':
        return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
      case 'isodate':
        return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      case 'newline':
        return '\n';
      case 'trim':
        return TRIM;
      case 'noop':
        return '';
      case 'lastmessage':
        return ctx.lastMessage;
      case 'original':
        return ctx.original;
      default:
        return undefined;
    }
  };

  /** One macro's value, or undefined when it is not one this resolver knows. */
  const evaluate = (body: string): string | undefined => {
    const expression = body.trim();
    if (expression.startsWith('//')) return '';
    const match = /^([a-z][a-z0-9_]*)([\s\S]*)$/i.exec(expression);
    if (!match) return undefined;
    const name = (match[1] ?? '').toLowerCase();
    const rest = (match[2] ?? '').trim();

    if (name === 'random' || name === 'pick') {
      const options = optionsOf(rest);
      if (!options?.length) return undefined;
      const index = name === 'random' ? Math.floor(draw() * options.length) : Math.floor(keyed(expression) * options.length);
      return options[Math.min(options.length - 1, index)];
    }
    if (name === 'roll') {
      const notation = optionsOf(rest)?.[0];
      const dice = notation === undefined ? null : DICE.exec(notation);
      if (!dice) return undefined;
      const count = dice[1] ? Number(dice[1]) : 1;
      const sides = Number(dice[2] ?? 0);
      if (count < 1 || count > MAX_DICE || sides < 1 || sides > MAX_SIDES) return undefined;
      let total = dice[3] ? Number(dice[3]) : 0;
      for (let die = 0; die < count; die += 1) total += 1 + Math.floor(draw() * sides);
      return String(total);
    }
    // A plain macro takes no arguments: `{{char name}}` is not one, so it stays as written.
    if (rest) return undefined;
    return plain(name);
  };

  // Legacy tokens are plain names, so they go first and may sit inside a macro.
  let out = text.replace(LEGACY_ALL, (_match, name: string) => hold(name.toLowerCase() === 'user' ? ctx.user : ctx.char));
  for (let depth = 0; depth < MAX_NESTING; depth += 1) {
    const before = out;
    out = out.replace(INNERMOST, (_match, inner: string) => {
      const body = unhold(inner);
      // An unknown macro keeps its text, with any resolved inner macros already in it.
      return hold(evaluate(body) ?? `{{${body}}}`);
    });
    if (out === before) break;
  }

  const resolved = unhold(out);
  return resolved.includes(TRIM) ? resolved.replace(/\n*\u0003\n*/g, '') : resolved;
}

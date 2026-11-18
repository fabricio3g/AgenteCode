/**
 * Props — the roleplay's own artifacts.
 *
 * When the scene puts something in the user's hands, the reply carries a block
 * beside the prose:
 *
 *   [prop]
 *   title: A letter, sealed
 *   kind: letter
 *   body: ...
 *   [/prop]
 *
 * The block is parsed out and becomes a card in the reply and an entry in the
 * scene journal. It never routes through the agent artifact stack: those are
 * work products — reports, spreadsheets, decks — and they have no place in a
 * scene.
 *
 * Parsing is deliberately tolerant, same contract as roleplay-choices: models
 * drop the closing tag, use a heading, bold things, or number the fields.
 */

import { ROLEPLAY_PROP_KINDS, type RoleplayProp, type RoleplayPropKind } from '$lib/types/chat';

const PROP_KINDS = ROLEPLAY_PROP_KINDS;
export type PropKind = RoleplayPropKind;
export type { RoleplayProp };

export interface ExtractedProps {
  /** The reply with every closed prop block removed. */
  text: string;
  props: RoleplayProp[];
}

const HEADER = /^\s*(?:\[\s*prop\s*\]|<\s*prop\s*>|#{1,6}\s*prop\s*:?|\*{0,2}prop\*{0,2}\s*:)\s*$/i;
const FOOTER = /^\s*(?:\[\s*\/\s*prop\s*\]|<\s*\/\s*prop\s*>)\s*$/i;
const FIELD = /^\s*(?:[-*•]|\d+[.)])?\s*(title|name|kind|body|text)\s*:\s*(.*)$/i;

/** More than this in one reply reads as the model showing off. */
export const MAX_PROPS_PER_REPLY = 3;

export function normalizePropKind(value: string): PropKind {
  const kind = String(value || '').trim().toLowerCase();
  return (PROP_KINDS as readonly string[]).includes(kind) ? (kind as PropKind) : 'object';
}

function parseProp(lines: string[]): RoleplayProp | null {
  const fields = new Map<string, string>();
  const loose: string[] = [];

  for (const raw of lines) {
    const line = raw.replace(/\*\*|__/g, '');
    const match = FIELD.exec(line);
    if (match) {
      fields.set(match[1]!.toLowerCase(), match[2]!.trim());
      continue;
    }
    if (line.trim()) loose.push(line.trim());
  }

  let title = fields.get('title') || fields.get('name') || '';
  let body = fields.get('body') || fields.get('text') || '';

  if (!title && !body) {
    // Nothing labelled: the first line names it and the rest is the body.
    title = loose[0] || '';
    body = loose.slice(1).join('\n');
  } else if (!title) {
    title = loose[0] || '';
  } else if (!body) {
    body = loose.join('\n');
  }

  if (!title.trim() && !body.trim()) return null;

  return {
    title: title.trim() || 'Something handed over',
    kind: normalizePropKind(fields.get('kind') || ''),
    body: body.trim()
  };
}

/**
 * Pull prop blocks out of a finished reply.
 *
 * An unclosed block still counts here: this runs on the raw accumulation at
 * finalize, where a dropped closing tag should not cost the whole prop.
 */
export function extractRoleplayProps(content: string): ExtractedProps {
  const lines = (content || '').split('\n');
  const props: RoleplayProp[] = [];
  const kept: string[] = [];
  let block: string[] | null = null;

  for (const line of lines) {
    if (!block && HEADER.test(line)) {
      block = [];
      continue;
    }
    if (block && FOOTER.test(line)) {
      const prop = parseProp(block);
      if (prop && props.length < MAX_PROPS_PER_REPLY) props.push(prop);
      block = null;
      continue;
    }
    if (block) {
      block.push(line);
      continue;
    }
    kept.push(line);
  }

  if (block?.length) {
    const prop = parseProp(block);
    if (prop && props.length < MAX_PROPS_PER_REPLY) props.push(prop);
  }

  return {
    text: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    props
  };
}

/**
 * Hide prop markup from the bubble while a reply streams.
 *
 * Only *closed* blocks are removed, which is not what roleplay-choices does —
 * and the difference matters. A choices block is terminal, so swallowing an
 * open one costs nothing but a stray line or two. A prop block sits in the
 * middle of the reply, so swallowing an open one would take the prose after it
 * with it. Because the streaming sanitizer accumulates its own cleaned output
 * (`app-store-helpers.appendStreamingContent`), that loss would be permanent.
 */
export function stripRoleplayPropBlock(content: string): string {
  // Fast path: nothing that could open a block, so nothing to scan for.
  if (!content || (!content.includes('[prop') && !content.includes('<prop') && !/\bprop\s*:/i.test(content))) {
    return content;
  }

  const lines = content.split('\n');
  const kept: string[] = [];
  let block: string[] | null = null;

  for (const line of lines) {
    if (!block && HEADER.test(line)) {
      block = [line];
      continue;
    }
    if (block) {
      block.push(line);
      if (FOOTER.test(line)) block = null;
      continue;
    }
    kept.push(line);
  }

  // An open block is left visible on purpose — see the note above.
  return [...kept, ...(block || [])].join('\n');
}

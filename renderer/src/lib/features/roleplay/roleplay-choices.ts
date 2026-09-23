/**
 * Adventure choices (CYOA).
 *
 * When a scene enables them, replies end with a block:
 *
 *   [choices]
 *   - Open the door
 *   - Call out to Rachel
 *   [/choices]
 *
 * The block is parsed out of the reply and the options become clickable. The
 * parser is deliberately tolerant: models drop the closing tag, use a heading,
 * number the options, or wrap them in bold.
 */

export interface RoleplayChoices {
  /** The reply with the choices block removed. */
  text: string;
  /** 0–6 options, in order. */
  choices: string[];
}

const HEADER = /^\s*(?:\[\s*choices\s*\]|<\s*choices\s*>|#{1,6}\s*choices\s*:?|\*{0,2}choices\*{0,2}\s*:)\s*$/i;
const FOOTER = /^\s*(?:\[\s*\/\s*choices\s*\]|<\s*\/\s*choices\s*>)\s*$/i;

/** Remove the choices block from display text (used while streaming). */
export function stripRoleplayChoiceBlock(content: string): string {
  const { text, choices } = extractRoleplayChoices(content);
  return choices.length ? text : content;
}

export function extractRoleplayChoices(content: string): RoleplayChoices {
  const raw = content || '';
  const lines = raw.split('\n');

  let start = -1;
  let end = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (start < 0 && HEADER.test(line)) {
      start = index;
      continue;
    }
    if (start >= 0 && FOOTER.test(line)) {
      end = index;
      break;
    }
  }
  if (start < 0) return { text: raw, choices: [] };

  const bodyLines = lines.slice(start + 1, end < 0 ? lines.length : end);
  const choices = bodyLines
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/\*\*|__/g, '').trim())
    .filter((line) => line && !HEADER.test(line) && !FOOTER.test(line))
    .slice(0, 6);
  if (!choices.length) return { text: raw, choices: [] };

  const kept = [...lines.slice(0, start), ...(end >= 0 ? lines.slice(end + 1) : [])];
  return {
    text: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    choices
  };
}

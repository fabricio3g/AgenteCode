/**
 * Sample exchanges: how a character talks, edited as a list of lines and stored
 * in the card's `<START>` format (the community spec's example dialogue).
 *
 * The card format is an implementation detail of import and export. The editor
 * works on `Exchange`s whose lines are spoken by `'user'`, `'char'` or a literal
 * name the card used; serialising writes `{{user}}` and `{{char}}`, so the
 * macros resolve like every other card field.
 */

export type Speaker = 'user' | 'char' | `name:${string}`;

export interface ExampleLine {
  speaker: Speaker;
  text: string;
}

export interface Exchange {
  id: string;
  lines: ExampleLine[];
}

const START = /^\s*<START>\s*$/i;
const SPEAKER = /^\s*(\{\{\s*user\s*\}\}|\{\{\s*char\s*\}\}|<USER>|<BOT>|<CHAR>|[^:\n<>{}]{1,40}?)\s*:\s?(.*)$/i;

function speakerOf(raw: string): Speaker {
  const name = raw.trim().toLowerCase();
  if (name === '{{user}}' || name === '<user>' || name === '{{ user }}') return 'user';
  if (name === '{{char}}' || name === '<bot>' || name === '<char>' || name === '{{ char }}') return 'char';
  return `name:${raw.trim()}`;
}

/** The label a speaker carries in the card's text. */
export function speakerTag(speaker: Speaker): string {
  if (speaker === 'user') return '{{user}}';
  if (speaker === 'char') return '{{char}}';
  return speaker.slice('name:'.length);
}

let counter = 0;
const nextId = () => `exchange-${Date.now().toString(36)}-${(counter += 1)}`;

/** Card text → exchanges. Text without any `<START>` is one exchange. */
export function parseExchanges(text: string | null | undefined): Exchange[] {
  const source = (text ?? '').replace(/\r\n?/g, '\n');
  if (!source.trim()) return [];
  const blocks: string[][] = [[]];
  for (const line of source.split('\n')) {
    if (START.test(line)) blocks.push([]);
    else blocks[blocks.length - 1].push(line);
  }
  return blocks.flatMap((block) => {
    const lines: ExampleLine[] = [];
    for (const raw of block) {
      const match = SPEAKER.exec(raw);
      if (match) {
        lines.push({ speaker: speakerOf(match[1]), text: match[2] });
      } else if (lines.length) {
        lines[lines.length - 1].text += `\n${raw}`;
      } else if (raw.trim()) {
        lines.push({ speaker: 'char', text: raw });
      }
    }
    return lines.some((line) => line.text.trim()) ? [{ id: nextId(), lines }] : [];
  });
}

/** Exchanges → card text. Blank lines are dropped; an empty list is an empty field. */
export function serializeExchanges(exchanges: Exchange[]): string {
  return exchanges
    .map((exchange) => {
      const rows = exchange.lines
        .filter((line) => line.text.trim())
        .map((line) => `${speakerTag(line.speaker)}: ${line.text.trim()}`);
      return rows.length ? ['<START>', ...rows].join('\n') : '';
    })
    .filter(Boolean)
    .join('\n');
}

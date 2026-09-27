/**
 * Roleplay output hygiene and the boundaries that keep a reply in its lane.
 *
 * Group chats send history as `Name: "…"` so the model can tell speakers
 * apart — and models happily mimic the format back. The reply is cleaned at
 * ingest, so the bubble, copy and export never show a name twice.
 *
 * The same seam owns the stop strings sent with a roleplay request and the
 * cleanup of whatever leaked past them: one place to answer "why is there a
 * stray name in this reply?".
 */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Remove a leading speaker prefix (`Name:`, `**Name:**`, `Name：`) from a reply.
 *
 * Only names that belong to the scene are stripped, so ordinary prose like
 * "Note:" survives. Repeated prefixes are removed (models occasionally echo
 * two), and a prefix without a colon is left alone.
 */
export function stripSpeakerPrefix(text: string, names: Iterable<string>): string {
  if (!text) return text;
  const candidates = [...names]
    .map((name) => String(name || '').trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!candidates.length) return text;

  const alternation = candidates.map(escapeRegExp).join('|');
  const pattern = new RegExp(
    `^\\s*(?:\\*\\*|__)?\\s*(?:${alternation})\\s*(?:\\*\\*|__)?\\s*[:：]\\s*(?:\\*\\*|__)?\\s*`,
    'iu'
  );

  let output = text;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = output.replace(pattern, '');
    if (next === output) break;
    output = next;
  }
  return output;
}

/**
 * Provider stop-sequence caps are not generous — OpenAI accepts four and
 * Gemini rejects anything above five — so four is what every provider gets.
 * The colon forms go first because they mark a real turn boundary.
 */
export const ROLEPLAY_STOP_LIMIT = 4;

/**
 * Sequences that end generation early, one per turn boundary in the scene.
 *
 * A reply is cut the moment the model starts a line that is not its own. The
 * speaker's own name is deliberately left out: a model that re-labels its own
 * paragraphs should be cleaned at ingest rather than have its reply truncated.
 */
export function buildRoleplayStopStrings(params: {
  userName?: string;
  speakerName?: string;
  castNames?: Iterable<string>;
  /**
   * A turn may voice several characters, so their names are not turn
   * boundaries — only the user's name still ends a reply.
   */
  allowMultiSpeaker?: boolean;
  limit?: number;
}): string[] {
  const speaker = String(params.speakerName || '').trim();
  const names: string[] = [];
  const add = (value: unknown) => {
    const name = String(value || '').trim();
    if (!name || name === speaker || names.includes(name)) return;
    names.push(name);
  };

  add(params.userName);
  if (!params.allowMultiSpeaker) {
    for (const name of params.castNames || []) add(name);
  }

  // Colon forms first, bare forms after: the bare form catches the leak where
  // the model writes a name and then runs out of road.
  return [
    ...names.map((name) => `\n${name}:`),
    ...names.map((name) => `\n${name}`)
  ].slice(0, params.limit ?? ROLEPLAY_STOP_LIMIT);
}

/** Shortest trailing fragment worth trimming — `"\nA"` is just a paragraph break. */
const MIN_STOP_FRAGMENT = 3;

/**
 * Trim a stop string the stream cut through, plus any complete one it reached.
 *
 * Finalize-only, on purpose: the streaming sanitizer accumulates its own
 * cleaned output, so a trim that fires mid-flight deletes prose for good. Text
 * heading for "\nUsers are nice" would lose "\nUser" on the way and never get
 * it back.
 */
export function stripTrailingPartialStop(text: string, stopStrings: Iterable<string>): string {
  if (!text) return text;
  let output = text;

  for (const stop of stopStrings) {
    if (!stop) continue;
    if (output.endsWith(stop)) {
      output = output.slice(0, output.length - stop.length);
      continue;
    }
    for (let cut = stop.length - 1; cut >= MIN_STOP_FRAGMENT; cut -= 1) {
      const fragment = stop.slice(0, cut);
      if (!output.endsWith(fragment)) continue;
      output = output.slice(0, output.length - fragment.length);
      break;
    }
  }

  return output;
}

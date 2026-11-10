/**
 * Lessons live in Home and nowhere else.
 *
 * One predicate decides every surface — the tool definition, the dispatcher,
 * the composer commands, the message actions and the offer chip — so Code,
 * Design and Roleplay cannot grow a lesson entry point by accident. A lesson
 * opened from the library in another space still renders, read-only.
 */
export function lessonsEnabled(contextMode?: string | null): boolean {
  return String(contextMode || '').trim().toLowerCase() === 'home';
}

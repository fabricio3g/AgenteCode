import { lessonsEnabled } from '$lib/services/lesson-surface';

/**
 * How a lesson gets asked for.
 *
 * Nothing here creates anything: each helper turns a deliberate user action —
 * a slash command, a message action, or a click on the offer chip — into the
 * text the composer should hold (or send). The agent then builds the lesson
 * because it was asked, not because it guessed. Home only.
 */

export type LessonMode = 'lesson' | 'practice';

export interface LessonAsk {
  mode: LessonMode;
  /** What the user typed after the command, or the quoted answer. */
  topic: string;
  /** What goes into the composer. */
  directive: string;
}

const COMMANDS: Array<{ command: string; mode: LessonMode }> = [
  { command: 'teach', mode: 'lesson' },
  { command: 'practice', mode: 'practice' }
];

const LESSON_DIRECTIVES = {
  lesson: 'Create an interactive lesson with create_lesson (mode "lesson") for: ',
  practice: 'Create a practice set with create_lesson (mode "practice") for: '
};

export function isLessonDirective(text: string): boolean {
  return Object.values(LESSON_DIRECTIVES).some(prefix => text.trimStart().startsWith(prefix));
}

/** `/teach the chain rule` → a directive; `null` when it is not a lesson ask. */
export function matchLessonCommand(text: string, contextMode?: string | null): LessonAsk | null {
  if (!lessonsEnabled(contextMode)) return null;
  const match = /^\s*\/(teach|practice)\b([\s\S]*)$/i.exec(String(text || ''));
  if (!match) return null;
  const mode = COMMANDS.find((entry) => entry.command === match[1].toLowerCase())?.mode ?? 'lesson';
  const topic = match[2].trim();
  return { mode, topic, directive: buildDirective(mode, topic) };
}

/** The instruction the agent receives. `topic` may be a quoted answer. */
function buildDirective(mode: LessonMode, topic: string): string {
  const subject = topic.trim() || 'the topic we have been discussing';
  return mode === 'practice'
    ? `${LESSON_DIRECTIVES.practice}${subject}. Same concept, no hints, no visuals, choice and numeric blocks only, mixed with the previous concept where it fits. End with a summary.`
    : `${LESSON_DIRECTIVES.lesson}${subject}. One concept: open with a question before any explanation, then explore/predict/steps as they help, and close with a summary. Every wrong option needs its own reason.`;
}

/**
 * `Teach me this` / `Practise this` on a reply: the composer gets the quoted
 * answer plus the directive, and the user presses Enter. Never sent here.
 */
export function lessonFromReply(reply: string, mode: LessonMode = 'lesson'): LessonAsk {
  const quote = String(reply || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
  return { mode, topic: quote, directive: buildDirective(mode, quote) };
}

/** Whether the affordances should exist at all: Home, and the type turned on. */
export function lessonAskAvailable(contextMode: string | null | undefined, lessonEnabled: boolean): boolean {
  return lessonEnabled && lessonsEnabled(contextMode);
}

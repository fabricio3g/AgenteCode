// A request for a file that says nothing about what goes in it ("create me
// a pdf") gets a question back, not a file. When the model asked and nothing
// was gathered yet, that question is the answer: building the file from the
// question itself only produced an empty "partial research" document and a
// failed run.

import type { ToolObservation } from '$lib/services/agent-types';
import { sanitizeAgentVisibleText } from '$lib/services/agent-parsing';

/** Longest reply still read as a clarifying question rather than content. */
const MAX_QUESTION_CHARS = 1_600;

export function asksUserForDetails(draft: string, observations: ToolObservation[]): boolean {
  if (observations.some((observation) => observation.success)) return false;
  const text = sanitizeAgentVisibleText(draft).trim();
  return text.length > 0 && text.length <= MAX_QUESTION_CHARS && text.includes('?');
}

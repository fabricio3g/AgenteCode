/**
 * The agent's opening line: before any planning, one short sentence telling
 * the user what it is about to do ("I'll check the current weather in Madrid.").
 *
 * A separate, tiny call with no tools and no thinking, so the line arrives in
 * seconds even on a local model — asking the main turn for it is unreliable
 * (small models skip it) and slow (it waits behind the whole thinking pass).
 */

import { agentStreamComplete } from '$lib/services/agent-llm';
import { sanitizeAgentVisibleText } from '$lib/services/agent-parsing';
import { isAbortError } from '$lib/utils/errors';
import { uid } from '$lib/services/agent-tool-dispatch';
import { emitSteps, prompt, type AgentRun } from '$lib/services/agent-run-context';

const PREFACE_MAX_CHARS = 220;
const PREFACE_TIMEOUT_MS = 20_000;

const PREFACE_SYSTEM = [
  'You are an assistant that is about to work on the user\'s request with tools (web search, live data, files, charts).',
  'Reply with ONE short sentence (at most 20 words) in the same language as the user, saying what you are going to do now.',
  'Examples: "I\'ll check the current weather in Madrid." / "Voy a buscar las últimas noticias sobre el tema."',
  'Do NOT answer the request, do not give facts or numbers, do not ask questions, no markdown.'
].join('\n');

/** First sentence only, trimmed to a line. */
function firstSentence(text: string): string {
  const clean = sanitizeAgentVisibleText(text).replace(/\s+/g, ' ').trim();
  const match = clean.match(/^.*?[.!?。！？](?=\s|$)/);
  return (match ? match[0] : clean).slice(0, PREFACE_MAX_CHARS).trim();
}

export async function runPreface(run: AgentRun): Promise<void> {
  const { plan, args } = run;
  if (plan.isInstant || plan.isCodeProfile || !prompt(run).trim()) return;

  const controller = new AbortController();
  const stop = () => controller.abort();
  args.signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, PREFACE_TIMEOUT_MS);
  let streamed = '';
  try {
    await agentStreamComplete({
      messages: [
        { role: 'system', content: PREFACE_SYSTEM },
        { role: 'user', content: prompt(run).slice(0, 2000) }
      ],
      signal: controller.signal,
      reasoningLevel: 'off',
      onContent: (text) => {
        streamed += text;
        const line = firstSentence(streamed);
        if (line) args.onContent?.(line);
        // One sentence is all we want: stop as soon as it is complete.
        if (/[.!?。！？]\s/.test(streamed) || streamed.includes('\n\n') || streamed.length > PREFACE_MAX_CHARS) stop();
      }
    });
  } catch (err) {
    if (args.signal?.aborted) throw err;
    if (!isAbortError(err)) return;
  } finally {
    clearTimeout(timer);
    args.signal?.removeEventListener('abort', stop);
  }
  const line = firstSentence(streamed);
  if (!line) return;
  run.steps.unshift({ id: uid('step'), type: 'done', label: 'Preface', status: 'done', preface: true, detail: line });
  emitSteps(run);
}

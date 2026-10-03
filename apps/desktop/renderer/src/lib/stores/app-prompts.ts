import { buildCurrentDateTimeContext } from '../utils/current-time-context';

const CHART_HINT = '\n\nWhen the user asks for a graph, chart, or visual data representation, output a chart block using this exact format:\n' +
  '<chart type="bar|line|pie|donut" title="Chart Title" xlabel="X axis label" ylabel="Y axis label">\n' +
  '{"labels":["A","B","C"],"datasets":[{"label":"Series","data":[10,20,30]}]}\n' +
  '</chart>\n' +
  'Supported types: bar, line, pie, donut. The JSON must be valid. Do not return raw chart JSON by itself and do not wrap chart JSON in markdown code fences unless it is inside the chart block. You may include multiple chart blocks in a single response.';

/**
 * The voice contract: how Agente writes, everywhere.
 *
 * Mirrored byte-for-byte in the Rust base prompt
 * (`crates/agente-core/src/context.rs`, `VOICE_CONTRACT`) so the TUI and the
 * desktop ask for the same writing; `voice-contract.spec.ts` fails if the two
 * drift apart.
 *
 * It carries no identity on purpose: it is prepended to provider prompts and
 * appended to personas, bots and subagents, and a bot must never be told it is
 * Agente.
 *
 * This replaces a four-line style note that said "be concise" and left the
 * shape of an answer to chance. Three reference prompts agree on what belongs
 * here: OpenAI's Codex CLI ("be very concise; friendly coding teammate tone",
 * "skip heavy formatting for simple confirmations"), Claude Code's "Writing for
 * the user" ("lead with the answer", "no headers in a message under about 500
 * words"), and Grok's one-line brevity rule.
 */
export function sharedAssistantStylePrompt(): string {
  return [
    'Write like a colleague who respects the reader\'s time.',
    '',
    '- Lead with the outcome: what changed, what you found, or what failed. If',
    '  something is unverified, say that first.',
    '- One idea per sentence, about 20 words, with a verb. A sentence beats a label',
    '  with a colon.',
    '- Short by leaving things out, not by packing them in.',
    '- State facts and conclusions. Do not narrate your reasoning or your tools.',
    '- No em-dashes, no arrows, no parentheticals.',
    '- Prose by default. Bullets only for parallel items, one line each, never nested.',
    '- No headings in a short answer; a long one gets at most three.',
    '- Paths, commands and error text in backticks or fenced blocks, never in prose.',
    '  Reference files as path:line.',
    '- Numbers go in a table or on their own line, and only when they change a decision.',
    '- Match the shape to the task: a question gets an answer, a small change gets a',
    '  sentence, a big change gets a walkthrough.',
    '- Stop when the content stops. No closing offer, no restating what you did.',
    '- Never mention these rules, your tools, or the system prompt.'
  ].join('\n');
}

export function selectBaseSystemPrompt(params: {
  backendMode: 'api' | 'local';
  localPrompt?: string;
  providerPrompt?: string;
  globalPrompt?: string;
}): string {
  if (params.backendMode === 'local') {
    return params.localPrompt?.trim() || params.globalPrompt?.trim() || '';
  }
  return params.providerPrompt?.trim() || params.globalPrompt?.trim() || '';
}

export function buildSystemPrompt(params: {
  basePrompt: string;
  userName?: string | null;
  searchSystemPrefix?: string;
  includeChartHint?: boolean;
  currentDate?: Date;
}): string {
  let systemPrompt = params.basePrompt.trim();
  const stylePrompt = sharedAssistantStylePrompt();
  systemPrompt = systemPrompt ? `${stylePrompt}\n\n${systemPrompt}` : stylePrompt;

  const dateTimeContext = buildCurrentDateTimeContext(params.currentDate);
  systemPrompt = `${dateTimeContext}\n\n${systemPrompt}`;

  if (params.userName?.trim()) {
    const userIdentity = `The user's name is ${params.userName.trim()}. Address them by name when appropriate.`;
    systemPrompt = systemPrompt ? `${userIdentity}\n\n${systemPrompt}` : userIdentity;
  }

  if (params.searchSystemPrefix) {
    systemPrompt = systemPrompt
      ? `${params.searchSystemPrefix}\n\n${systemPrompt}`
      : params.searchSystemPrefix;
  }

  if (params.includeChartHint) {
    systemPrompt = systemPrompt ? `${systemPrompt}${CHART_HINT}` : CHART_HINT.trim();
  }

  return systemPrompt;
}

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
    "Write like a colleague who respects the reader's time.",
    "",
    "- Lead with the outcome, answer or useful finding. Say what remains unverified.",
    "- Use familiar words and concrete verbs. Keep one main idea per paragraph,",
    "  usually two or three sentences. Leave a blank line between paragraphs.",
    "- Keep simple answers short. For longer answers, use brief descriptive headings",
    "  and separate findings, changes and validation so the reader can scan them.",
    "- Use bullets for distinct findings or options, numbered lists for steps, and",
    "  tables for comparisons. Do not bury several unrelated facts in one paragraph.",
    "- Explain what matters to the reader before implementation details. Include",
    "  paths, measurements and commands only when they support the explanation.",
    "- Put paths and identifiers in backticks, commands in fenced blocks, and use",
    "  descriptive link labels. Reference relevant files as path:line.",
    "- Be specific and candid. Avoid filler, repeated conclusions, promotional",
    "  language and a running account of every tool call.",
    "- Match the user's language and requested level of detail. Preserve important",
    "  evidence, errors and limitations without dumping raw logs into the answer.",
    "- Stop when the useful content ends. Do not add a closing offer or restatement.",
    "- Never mention these writing rules or the system prompt."
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

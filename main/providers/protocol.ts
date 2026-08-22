// ── Provider wire protocol ─────────────────────────────────────────────
// The normalized vocabulary every adapter emits (dsh's llm types, scaled to
// this app). Adapters translate their native wire format INTO these chunks;
// consumers (chat pipeline, agent loop) never see provider quirks. Failures
// are values, not throws: a stream ends with exactly one `finish` chunk,
// and every error carries a stable classification code.

export type ErrorCode =
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'QUOTA_EXCEEDED'
  | 'INVALID_REQUEST'
  | 'SERVER'
  | 'TIMEOUT'
  | 'TRANSPORT'
  | 'CONTEXT_WINDOW_EXCEEDED'
  | 'EMPTY_RESPONSE'
  | 'ABORTED'
  | 'UNKNOWN';

export interface LlmFailure {
  message: string;
  code: ErrorCode;
}

export type FinishReason =
  | { kind: 'stop' }
  | { kind: 'max-tokens' }
  | { kind: 'tool-calls' }
  | { kind: 'aborted' }
  | { kind: 'error'; failure: LlmFailure };

/** One streamed tool-call fragment; `argumentsDelta` is a raw JSON slice. */
export interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  argumentsDelta: string;
}

/** Canonical token accounting; snake_case matches the existing chat wire. */
export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  [extra: string]: unknown;
}

export type StreamChunk =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call-delta'; delta: ToolCallDelta }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason };

/** Non-streaming completion result — the long-standing chat wire shape. */
export interface CompletionResult {
  content: string;
  reasoning: string;
  usage: TokenUsage | null;
  toolCalls: Array<{ id: string; name: string; arguments: unknown }> | null;
  finishReason?: FinishReason;
}

/** Parameters every adapter accepts (superset; adapters ignore what they don't use). */
export interface StreamParams {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  messages: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: unknown;
  reasoning?: { level: string; budgetTokens?: number } | null;
  signal?: AbortSignal;
  [param: string]: unknown;
}

// ── Error classification ───────────────────────────────────────────────

const CONTEXT_WINDOW_RE =
  /context (?:window|length)(?:\s+(?:exceeded|overflow|too))?|maximum context|context_length_exceeded|too many tokens|input length exceeds/i;
const QUOTA_RE = /\b402\b|insufficient (?:credits|quota|balance)|billing/i;
const RATE_LIMIT_RE = /\b429\b|rate.?limit|too many requests/i;
const AUTH_RE = /\b40[13]\b|unauthorized|forbidden|invalid api key|incorrect api key|authentication/i;
const INVALID_REQUEST_RE = /\b(?:400|404|422)\b|invalid request|bad request|not found|unsupported(?:_parameter|_value)?|invalid_request_error/i;
const SERVER_RE = /\b5\d\d\b|internal server error|bad gateway|service unavailable|overloaded/i;
const TIMEOUT_RE = /\btime(?:d)?\s*-?\s*out\b|etimedout|deadline exceeded/i;
const TRANSPORT_RE =
  /\beconn(?:refused|reset|aborted)?\b|socket hang up|network|fetch failed|terminated|premature close|other side closed|stream ended (?:before|without)\b|epipe/i;

/**
 * Classify any thrown error or failure text into a stable code. This is the
 * ONE home for error heuristics — retry policies and UI copy switch on the
 * code, never on message regexes.
 */
export function classifyError(input: unknown): LlmFailure {
  if (input && typeof input === 'object') {
    const err = input as { status?: unknown; code?: unknown; message?: unknown; name?: unknown };
    const status = Number(err.status ?? err.code ?? 0);
    const message = String(err.message ?? input);

    // AbortError from an caller signal is not a failure worth retrying.
    if (err.name === 'AbortError' || err.name === 'AbortSignalTimeoutError') {
      return { message, code: 'ABORTED' };
    }
    if (status === 401 || status === 403) return { message, code: 'AUTH' };
    if (status === 402) return { message, code: 'QUOTA_EXCEEDED' };
    if (status === 429) return { message, code: 'RATE_LIMIT' };
    if (status >= 500 && status < 600) return { message, code: 'SERVER' };
    if (status === 400 || status === 404 || status === 422) {
      return { message, code: 'INVALID_REQUEST' };
    }
    return classifyText(message);
  }
  return classifyText(String(input ?? ''));
}

function classifyText(message: string): LlmFailure {
  if (CONTEXT_WINDOW_RE.test(message)) return { message, code: 'CONTEXT_WINDOW_EXCEEDED' };
  if (QUOTA_RE.test(message)) return { message, code: 'QUOTA_EXCEEDED' };
  if (RATE_LIMIT_RE.test(message)) return { message, code: 'RATE_LIMIT' };
  if (AUTH_RE.test(message)) return { message, code: 'AUTH' };
  if (TIMEOUT_RE.test(message)) return { message, code: 'TIMEOUT' };
  if (SERVER_RE.test(message)) return { message, code: 'SERVER' };
  if (INVALID_REQUEST_RE.test(message)) return { message, code: 'INVALID_REQUEST' };
  if (TRANSPORT_RE.test(message)) return { message, code: 'TRANSPORT' };
  return { message, code: 'UNKNOWN' };
}

/** Codes an automatic retry can plausibly fix. */
const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set([
  'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'
]);

export function isRetryableFailure(failure: LlmFailure): boolean {
  return RETRYABLE_CODES.has(failure.code);
}

/**
 * The one error type adapters throw. `message` stays human-readable for the
 * existing surfaces; `failure.code` lets policies react without re-parsing.
 */
export class LlmStreamError extends Error {
  readonly failure: LlmFailure;
  constructor(failure: LlmFailure) {
    super(failure.message);
    this.name = 'LlmStreamError';
    this.failure = failure;
  }
}

// ── Finish-reason mapping ──────────────────────────────────────────────

/**
 * Map an OpenAI-style finish_reason string onto the typed reason.
 * Accepts the casing variants providers actually send.
 */
export function mapOpenAiFinishReason(raw: string | null | undefined): FinishReason | null {
  if (!raw) return null;
  switch (raw) {
    case 'length':
    case 'max_tokens':
    case 'MAX_TOKENS':
      return { kind: 'max-tokens' };
    case 'tool_calls':
    case 'tool_use':
    case 'function_call':
      return { kind: 'tool-calls' };
    case 'stop':
    case 'end_turn':
    case 'STOP':
      return { kind: 'stop' };
    default:
      return { kind: 'error', failure: { message: `unknown finish reason "${raw}"`, code: 'UNKNOWN' } };
  }
}

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
  | { type: 'provider-state'; state: { provider: string; blocks: Array<Record<string, unknown>> } }
  | { type: 'finish'; reason: FinishReason };

/** Non-streaming completion result — the long-standing chat wire shape. */
export interface CompletionResult {
  /** Opaque signed content to replay on subsequent tool turns, never display text. */
  providerState?: { provider: string; blocks: Array<Record<string, unknown>> };
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
  /**
   * The chosen thinking level and the request fields the shared core built
   * for it (`thinking.request`); `body` is merged into the request as is.
   */
  reasoning?: { level: string; budgetTokens?: number; body?: Record<string, unknown> } | null;
  /**
   * Sequences that end generation early. Every adapter maps these to its own
   * wire name (`stop`, `stop_sequences`, `stopSequences`); the count is capped
   * upstream because the strictest provider accepts only four.
   */
  stop?: string[];
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
/**
 * OpenRouter wraps an upstream provider's failure in a generic message
 * ("JSON error injected into SSE stream"); the actual reason rides along in
 * `error.metadata` (provider name, raw upstream body). Keep it, so the error
 * says what actually went wrong.
 */
function withUpstreamDetail(message: string, body: unknown): string {
  const meta = (body && typeof body === 'object' ? (body as { metadata?: Record<string, unknown> }).metadata : undefined) ?? undefined;
  if (!meta) return message;
  const provider = typeof meta.provider_name === 'string' ? meta.provider_name : '';
  const raw = typeof meta.raw === 'string' ? meta.raw : meta.raw ? JSON.stringify(meta.raw) : '';
  const detail = [provider, raw.slice(0, 400)].filter(Boolean).join(': ');
  return detail && !message.includes(detail) ? `${message} (${detail})` : message;
}

export function classifyError(input: unknown): LlmFailure {
  if (input && typeof input === 'object') {
    if (input instanceof LlmStreamError) return input.failure;
    const err = input as { status?: unknown; code?: unknown; message?: unknown; name?: unknown };
    const body = (input as { error?: { code?: unknown; message?: unknown; metadata?: Record<string, unknown> } }).error;
    const status = Number(err.status ?? body?.code ?? err.code ?? 0);
    const message = withUpstreamDetail(String(err.message ?? body?.message ?? input), body ?? input);

    // AbortError from an caller signal is not a failure worth retrying.
    if (err.name === 'AbortError' || err.name === 'AbortSignalTimeoutError') {
      return { message, code: 'ABORTED' };
    }
    if (CONTEXT_WINDOW_RE.test(message)) return { message, code: 'CONTEXT_WINDOW_EXCEEDED' };
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
 *
 * `detail` carries the provider's own error payload when one arrives
 * alongside the finish (OpenRouter reports an upstream failure as
 * `finish_reason: "error"` on an HTTP-200 stream, with the real cause in
 * `choices[0].error`). Without it the UI could only print
 * `unknown finish reason "error"`.
 */
export function mapOpenAiFinishReason(raw: string | null | undefined, detail?: string): FinishReason | null {
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
    case 'error':
    case 'ERROR':
      return {
        kind: 'error',
        failure: {
          message: detail?.trim()
            ? detail.trim().slice(0, 300)
            : 'The provider reported an error while generating the reply.',
          code: 'SERVER'
        }
      };
    default:
      return { kind: 'error', failure: { message: `unknown finish reason "${raw}"`, code: 'UNKNOWN' } };
  }
}

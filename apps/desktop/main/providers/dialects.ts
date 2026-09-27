// ── Provider dialects ──────────────────────────────────────────────────
// One OpenAI-family core (openai-core.ts) is parameterized by these
// descriptors. Everything a provider used to hand-roll — reasoning body
// shape, base-URL normalization, extra headers, capability levels — lives
// here as data, so adding a provider is a row, not a class.

import type { ReasoningCapabilities } from './base.ts';

export interface Dialect {
  id: string;
  label: string;
  group: 'cloud' | 'local';
  defaultBaseUrl: string;
  /** sdk = OpenAI SDK; fetch-sse = raw POST + SSE parse. */
  transport: 'sdk' | 'fetch-sse';
  /** Host fragments that claim a bare base URL for this dialect. */
  matchHosts?: string[];
  /** Normalize a user-entered base URL into what the transport needs. */
  normalizeBaseUrl?: (baseUrl?: string) => string;
  /** Extra request headers (openrouter attribution). */
  headers?: (apiKey: string) => Record<string, string>;
  /**
   * Reasoning body fragment for a request. Receives the model id because
   * some dialects are family-aware (groq gpt-oss vs qwen).
   */
  reasoningBody?: (level: string | undefined, modelId?: string) => Record<string, unknown>;
  /** Family-aware capability check; return null to fall through to endpoint probing. */
  reasoningCapabilities?: (modelId?: string, modelPath?: string) => ReasoningCapabilities | null;
  /**
   * GET path that only succeeds with a valid key, for providers whose model
   * list is public (so listing models proves nothing about the key).
   */
  keyCheckPath?: string;
  /**
   * Send stream_options.include_usage on streaming requests. Only set this
   * where the old provider did — strict endpoints reject unknown params.
   */
  streamUsage?: boolean;
}

/** Plain {reasoning_effort} dialects share this body builder. */
function effortBody(level: string | undefined): Record<string, unknown> {
  if (!level) return {};
  if (level === 'off' || level === 'disabled') return { reasoning_effort: 'none' };
  return { reasoning_effort: level };
}

// ── DeepSeek thinking (api-docs.deepseek.com/guides/thinking_mode) ─────

const DEEPSEEK_LEVELS = ['off', 'high', 'max'] as const;

function deepseekReasoningBody(level: string | undefined): Record<string, unknown> {
  if (!level) return {};
  if (level === 'off' || level === 'disabled' || level === 'minimal' || level === 'none') {
    return { thinking: { type: 'disabled' } };
  }
  const effort = level === 'max' || level === 'xhigh' ? 'max' : 'high';
  return { thinking: { type: 'enabled' }, reasoning_effort: effort };
}

// ── Local llama.cpp (chat_template_kwargs.enable_thinking) ─────────────
// Current llama.cpp has no top-level `disable_thinking` request field — one
// sent there is silently ignored, so thinking never actually switched. The
// live mechanism is the Jinja kwarg (the same shape the bundled llama-ui
// WebUI sends), with `reasoning_format: auto` so thoughts come back in
// `reasoning_content` instead of leaking into the answer text. Only explicit
// on/off levels map; anything else is omitted so the server default
// (--reasoning flag / template default) applies. Values must be real
// booleans: the server 400s on the string "false".
function localReasoningBody(level: string | undefined): Record<string, unknown> {
  if (level === 'off' || level === 'disabled' || level === 'none') {
    return { reasoning_format: 'auto', chat_template_kwargs: { enable_thinking: false } };
  }
  if (level === 'on' || level === 'enabled') {
    return { reasoning_format: 'auto', chat_template_kwargs: { enable_thinking: true } };
  }
  return { reasoning_format: 'auto' };
}

// ── The table ──────────────────────────────────────────────────────────

export const DIALECTS: Dialect[] = [
  {
    // OpenCode Go: a flat subscription to open models behind one
    // OpenAI-compatible endpoint (opencode.ai/docs/go).
    id: 'opencode-go',
    label: 'OpenCode Go',
    group: 'cloud',
    defaultBaseUrl: 'https://opencode.ai/zen/go/v1',
    transport: 'sdk',
    matchHosts: ['opencode.ai'],
    streamUsage: true,
    reasoningBody: effortBody,
    reasoningCapabilities(modelId) {
      void modelId;
      return null; // probe the catalog
    }
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    group: 'cloud',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    transport: 'sdk',
    matchHosts: ['openrouter.ai'],
    keyCheckPath: '/key',
    headers() {
      return { 'HTTP-Referer': 'https://github.com/fabricio3g/Flaxeo-Chat', 'X-Title': 'Flaxeo Chat' };
    },
    reasoningBody(level) {
      if (!level) return {};
      if (level === 'off') return { reasoning: { effort: 'none' } };
      if (level === 'enabled' || level === 'on') return { reasoning: { effort: 'medium' } };
      if (level === 'disabled') return { reasoning: { effort: 'none' } };
      return { reasoning: { effort: level } };
    },
    reasoningCapabilities(modelId) {
      // Route ids carry no family signal — always probe the catalog.
      void modelId;
      return null;
    }
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    group: 'cloud',
    defaultBaseUrl: 'https://api.deepseek.com',
    transport: 'sdk',
    matchHosts: ['api.deepseek.com'],
    streamUsage: true,
    normalizeBaseUrl(baseUrl) {
      // DeepSeek's compat root has no /v1; the SDK appends /chat/completions.
      return String(baseUrl || '').trim().replace(/\/+$/, '') || 'https://api.deepseek.com';
    },
    reasoningBody: deepseekReasoningBody,
    reasoningCapabilities(modelId) {
      void modelId;
      return { supported: true, levels: [...DEEPSEEK_LEVELS], paramShape: 'openai_reasoning_effort', source: 'sdk' };
    }
  },
  {
    id: 'local',
    label: 'Local (llama.cpp)',
    group: 'local',
    defaultBaseUrl: 'http://127.0.0.1:11435/v1',
    transport: 'fetch-sse',
    matchHosts: ['127.0.0.1', 'localhost'],
    streamUsage: true,
    normalizeBaseUrl(baseUrl) {
      const normalized = String(baseUrl || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
      return normalized || 'http://127.0.0.1:11435/v1';
    },
    reasoningBody: localReasoningBody
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    group: 'local',
    defaultBaseUrl: 'http://localhost:1234/v1',
    transport: 'sdk',
    reasoningBody: effortBody
  },
  {
    id: 'ollama',
    label: 'Ollama',
    group: 'local',
    defaultBaseUrl: 'http://localhost:11434/v1',
    transport: 'sdk',
    reasoningBody: effortBody,
    streamUsage: true
  },
  {
    id: 'custom',
    label: 'Custom / Other',
    group: 'local',
    // Custom endpoints always carry their own URL; this only fills a blank.
    defaultBaseUrl: 'http://127.0.0.1:8080/v1',
    transport: 'sdk',
    reasoningBody: effortBody
  }
];

export function getDialect(id: string): Dialect | undefined {
  return DIALECTS.find((d) => d.id === id);
}

/**
 * Resolve which dialect owns a route — same detection semantics the old
 * provider classes had, now one ordered scan over the table.
 */
export function resolveDialect(providerName?: string, baseUrl?: string): Dialect {
  const name = String(providerName || '').toLowerCase();
  const url = String(baseUrl || '').toLowerCase();

  // Explicit protocol selection wins, including local gateways for SDK providers.
  const named = getDialect(name);
  if (named) return named;
  let hostname = '';
  try { hostname = new URL(url).hostname; } catch { /* no usable URL */ }
  if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]') {
    return getDialect('local')!;
  }

  for (const dialect of DIALECTS) {
    if (name === dialect.id) return dialect;
    if (dialect.matchHosts?.some((host) => hostname === host || hostname.endsWith(`.${host}`))) return dialect;
  }

  return getDialect('custom')!;
}

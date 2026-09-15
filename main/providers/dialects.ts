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
  /** sdk = OpenAI SDK; fetch-sse = raw POST + SSE parse; mistral = Mistral SDK envelope. */
  transport: 'sdk' | 'fetch-sse' | 'mistral';
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
   * Send stream_options.include_usage on streaming requests. Only set this
   * where the old provider did — strict endpoints reject unknown params.
   */
  streamUsage?: boolean;
}

const EFFORT_LEVELS = ['off', 'low', 'medium', 'high'] as const;

/** Plain {reasoning_effort} dialects share this body builder. */
function effortBody(level: string | undefined): Record<string, unknown> {
  if (!level) return {};
  if (level === 'off' || level === 'disabled') return { reasoning_effort: 'none' };
  return { reasoning_effort: level };
}

/**
 * Probe-style capabilities shared by openai-compatible endpoints: accept the
 * effort param when the model's record advertises it.
 */
function supportedParametersCaps(record: Record<string, unknown>, levels: readonly string[]): ReasoningCapabilities {
  const params = Array.isArray(record.supported_parameters) ? record.supported_parameters as string[] : [];
  const accepts = params.includes('reasoning_effort') || params.includes('reasoning') || !!record.reasoning;
  return {
    supported: accepts,
    levels: accepts ? [...levels] as ReasoningCapabilities['levels'] : [],
    paramShape: 'openai_reasoning_effort',
    source: 'api'
  };
}

// ── Groq family logic (console.groq.com/docs/reasoning) ────────────────

const GROQ_GPT_OSS_LEVELS = ['low', 'medium', 'high'] as const;
const GROQ_QWEN_LEVELS = ['none', 'default'] as const;

function groqFamily(modelId?: string): 'gpt-oss' | 'qwen' | null {
  const id = String(modelId || '').toLowerCase();
  if (!id) return null;
  if (id.includes('gpt-oss')) return 'gpt-oss';
  if (id.includes('qwen')) return 'qwen';
  return null;
}

function groqReasoningBody(level: string | undefined, modelId?: string): Record<string, unknown> {
  const family = groqFamily(modelId);
  if (family === 'gpt-oss') {
    if (level === 'low' || level === 'medium' || level === 'high') {
      return { reasoning_effort: level, include_reasoning: true };
    }
    return {};
  }
  if (family === 'qwen') {
    // Groq requires parsed or hidden format when combining reasoning and tools.
    if (!level) return { reasoning_format: 'parsed' };
    if (level === 'off') return { reasoning_effort: 'none', reasoning_format: 'parsed' };
    if (level === 'none' || level === 'default') {
      return { reasoning_effort: level, reasoning_format: 'parsed' };
    }
    if (level === 'disabled' || level === 'minimal') {
      return { reasoning_effort: 'none', reasoning_format: 'parsed' };
    }
    if (['low', 'medium', 'high', 'on', 'enabled'].includes(level)) {
      return { reasoning_effort: 'default', reasoning_format: 'parsed' };
    }
  }
  return {};
}

function groqReasoningCapabilities(modelId?: string): ReasoningCapabilities | null {
  const family = groqFamily(modelId);
  if (family === 'gpt-oss') {
    return { supported: true, levels: [...GROQ_GPT_OSS_LEVELS], paramShape: 'openai_reasoning_effort', source: 'sdk' };
  }
  if (family === 'qwen') {
    return { supported: true, levels: [...GROQ_QWEN_LEVELS], paramShape: 'openai_reasoning_effort', source: 'sdk' };
  }
  // Unknown family → let the endpoint probe decide.
  return null;
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

// ── Mistral adjustable reasoning ───────────────────────────────────────

const MISTRAL_LEVELS = ['off', 'none', 'high'] as const;
const MISTRAL_REASONING_MODEL_RE = /mistral-small|mistral-medium|magistral|mistral-medium-3/i;

function mistralReasoningBody(level: string | undefined): Record<string, unknown> {
  if (!level) return {};
  if (level === 'off') return { reasoningEffort: 'none' };
  if (level === 'none' || level === 'high') return { reasoningEffort: level };
  // Compat for shared UI levels: low/medium → high, disabled variants → none.
  if (['low', 'medium', 'on', 'enabled', 'default'].includes(level)) return { reasoningEffort: 'high' };
  if (['disabled', 'minimal'].includes(level)) return { reasoningEffort: 'none' };
  return {};
}

function mistralReasoningCapabilities(modelId?: string): ReasoningCapabilities | null {
  if (MISTRAL_REASONING_MODEL_RE.test(String(modelId || ''))) {
    return { supported: true, levels: [...MISTRAL_LEVELS], paramShape: 'mistral_reasoning_effort', source: 'sdk' };
  }
  // Unknown → probe the models list for a reasoning flag before giving up.
  return null;
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
    id: 'anthropic',
    label: 'Anthropic',
    group: 'cloud',
    defaultBaseUrl: 'https://api.anthropic.com',
    transport: 'sdk'
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    group: 'cloud',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    transport: 'sdk'
  },
  {
    id: 'groq',
    label: 'Groq',
    group: 'cloud',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    transport: 'sdk',
    matchHosts: ['api.groq.com'],
    normalizeBaseUrl(baseUrl) {
      // Accept either form; the OpenAI SDK needs the full /openai/v1 path.
      const raw = String(baseUrl || '').trim().replace(/\/+$/, '');
      const host = raw.replace(/\/openai\/v1$/i, '') || 'https://api.groq.com';
      return `${host}/openai/v1`;
    },
    reasoningBody: groqReasoningBody,
    reasoningCapabilities: groqReasoningCapabilities
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    group: 'cloud',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    transport: 'sdk',
    matchHosts: ['openrouter.ai'],
    headers() {
      return { 'HTTP-Referer': 'https://chatea.app', 'X-Title': 'Chatea' };
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
    id: 'mistral',
    label: 'Mistral AI',
    group: 'cloud',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    transport: 'mistral',
    matchHosts: ['mistral.ai'],
    reasoningBody: mistralReasoningBody,
    reasoningCapabilities: mistralReasoningCapabilities
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
    id: 'openai',
    label: 'OpenAI',
    group: 'cloud',
    defaultBaseUrl: 'https://api.openai.com/v1',
    transport: 'sdk',
    matchHosts: ['api.openai.com'],
    streamUsage: true,
    reasoningBody: effortBody,
    reasoningCapabilities(modelId) {
      void modelId;
      return null; // probe via models.retrieve
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
    id: 'together',
    label: 'Together AI',
    group: 'cloud',
    defaultBaseUrl: 'https://api.together.xyz/v1',
    transport: 'sdk',
    matchHosts: ['api.together.xyz'],
    reasoningBody: effortBody
  },
  {
    id: 'cohere',
    label: 'Cohere',
    group: 'cloud',
    defaultBaseUrl: 'https://api.cohere.ai/compatibility/v1',
    transport: 'sdk',
    matchHosts: ['api.cohere.ai'],
    normalizeBaseUrl(baseUrl) {
      const raw = String(baseUrl || '').trim().replace(/\/+$/, '');
      // Repair the old settings default; preserve custom gateways.
      return !raw || /^https:\/\/api\.cohere\.(ai|com)(\/v1)?$/.test(raw)
        ? 'https://api.cohere.ai/compatibility/v1' : raw;
    },
    reasoningBody(level) {
      if (!level) return {};
      return { reasoning_effort: ['off', 'none', 'disabled'].includes(level) ? 'none' : 'high' };
    }
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    group: 'cloud',
    defaultBaseUrl: 'https://api.perplexity.ai',
    transport: 'sdk',
    matchHosts: ['api.perplexity.ai'],
    reasoningBody: effortBody
  },
  {
    id: 'custom',
    label: 'Custom / Other',
    group: 'local',
    defaultBaseUrl: 'https://api.openai.com/v1',
    transport: 'sdk',
    reasoningBody: effortBody
  }
];

/** Anthropic and Gemini have their own wire protocols and their own adapters. */
export const ADAPTER_DIALECT_IDS = new Set(['anthropic', 'gemini']);

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
    if (ADAPTER_DIALECT_IDS.has(dialect.id)) continue; // adapters detect below
    if (name === dialect.id) return dialect;
    if (dialect.matchHosts?.some((host) => hostname === host || hostname.endsWith(`.${host}`))) return dialect;
  }

  // Adapter-owned protocols detect on looser aliases (claude, google, …).
  if (name.includes('anthropic') || name.includes('claude') || name === 'claude'
    || url.includes('anthropic.com') || url.includes('claude.ai')) {
    return getDialect('anthropic')!;
  }
  if (name === 'gemini' || name === 'google' || name === 'googleai'
    || url.includes('generativelanguage.googleapis.com')) {
    return getDialect('gemini')!;
  }

  return getDialect('custom')!;
}

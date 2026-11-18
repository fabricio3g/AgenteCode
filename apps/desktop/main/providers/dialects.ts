// ── Provider dialects ──────────────────────────────────────────────────
// One OpenAI-family core (openai-core.ts) is parameterized by these
// descriptors: transport, base-URL normalization, extra headers. Thinking
// levels and their request fields are not here — they come from the shared
// Rust core (`crates/agente-core/providers/*.toml`, `agente_core::thinking`)
// through the daemon, the same source Agente Code's TUI uses
// (see ../agente/thinking.ts).

import crypto from 'node:crypto';
import { APP_NAME, APP_REPO_URL } from '../../shared/brand.ts';

/**
 * OpenCode Go refuses requests without `x-opencode-session` (the Rust core
 * sends one per session). Desktop's own direct calls (titles, short
 * replies) share one per app run, so they still route to a warm cache.
 */
const OPENCODE_SESSION = crypto.randomUUID();

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
   * Fields every request carries (llama-server: `reasoning_format: auto`, so
   * thoughts come back in `reasoning_content` instead of the answer text).
   */
  baseBody?: Record<string, unknown>;
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

// ── The table ──────────────────────────────────────────────────────────

const DIALECTS: Dialect[] = [
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
    headers() {
      return { 'x-opencode-session': OPENCODE_SESSION };
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
      return { 'HTTP-Referer': APP_REPO_URL, 'X-Title': APP_NAME };
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
    baseBody: { reasoning_format: 'auto' }
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    group: 'local',
    defaultBaseUrl: 'http://localhost:1234/v1',
    transport: 'sdk'
  },
  {
    id: 'ollama',
    label: 'Ollama',
    group: 'local',
    defaultBaseUrl: 'http://localhost:11434/v1',
    transport: 'sdk',
    streamUsage: true
  },
  {
    id: 'custom',
    label: 'Custom / Other',
    group: 'local',
    // Custom endpoints always carry their own URL; this only fills a blank.
    defaultBaseUrl: 'http://127.0.0.1:8080/v1',
    transport: 'sdk'
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
    return getDialect(name ? 'custom' : 'local')!;
  }

  for (const dialect of DIALECTS) {
    if (name === dialect.id) return dialect;
    if (dialect.matchHosts?.some((host) => hostname === host || hostname.endsWith(`.${host}`))) return dialect;
  }

  return getDialect('custom')!;
}

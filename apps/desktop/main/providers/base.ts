// ── Reasoning capability vocabulary ─────────────────────────────────────
// Levels come from the shared Rust core (agente_core::thinking) through the
// daemon — the same profile Agente Code's TUI shows (see ../agente/thinking.ts).
// The renderer only shows the selector when `supported: true` with a known
// `source`. Nothing is guessed from model names in shared code.

export type ReasoningLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'max'
  | 'xhigh'
  | 'enabled'
  | 'disabled'
  | 'on'
  | 'none'
  | 'default'; // Groq Qwen reasoning_effort

/** How a model's thinking levels were learned (see agente_core::thinking). */
export type ReasoningSource = 'catalog' | 'live' | 'template' | 'unknown';

export type ReasoningCapabilities = {
  /** The selector has at least two choices (Auto plus one level). */
  supported: boolean;
  /** Concrete choices, low → high; Auto is implied. */
  levels: ReasoningLevel[];
  source: ReasoningSource;
  /** What Auto resolves to, when the provider says. */
  default?: ReasoningLevel;
  /** The model always thinks — there is no Off. */
  mandatory?: boolean;
  /** Thinking-token budget of the levels that have one (the rest are sized by the provider). */
  budgets?: Partial<Record<ReasoningLevel, number>>;
};

export type ReasoningRequest = {
  level: ReasoningLevel;
  budgetTokens?: number;
  /** Request fields the core built for this level (merged as is). */
  body?: Record<string, unknown>;
};

// ── Reasoning capability vocabulary ─────────────────────────────────────
// Each provider declares what reasoning levels it supports and how they are
// wired into its native API body (see dialects.ts and the adapters). The
// renderer asks via IPC and only shows the selector when `supported: true`
// with a known `source`. We never guess from model names in shared code.

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

export type ReasoningParamShape =
  | 'openai_reasoning_effort'   // { reasoning_effort: 'low' }
  | 'anthropic_thinking'        // { thinking: { type, budget_tokens?, effort? } }
  | 'gemini_thinking_budget'    // { generationConfig: { thinkingConfig: { thinkingBudget } } }
  | 'mistral_reasoning_effort'  // { reasoningEffort: 'high' | 'none' }
  | 'local_enable_thinking';    // { chat_template_kwargs: { enable_thinking: bool } }

export type ReasoningCapabilities = {
  supported: boolean;
  levels: ReasoningLevel[];
  paramShape: ReasoningParamShape;
  source: 'sdk' | 'api' | 'metadata' | 'unknown';
};

export type ReasoningRequest = {
  level: ReasoningLevel;
  budgetTokens?: number;
};

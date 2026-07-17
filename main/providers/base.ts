// ── Reasoning capabilities ──────────────────────────────────────────────
// Each provider declares what reasoning levels it supports and how to wire
// them into its native API body. The renderer asks the provider (via IPC)
// and only shows the selector when the provider returns `supported: true`
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
  | 'none';

export type ReasoningParamShape =
  | 'openai_reasoning_effort'   // { reasoning_effort: 'low' }
  | 'anthropic_thinking'        // { thinking: { type, budget_tokens?, effort? } }
  | 'gemini_thinking_budget'    // { generationConfig: { thinkingConfig: { thinkingBudget } } }
  | 'mistral_reasoning_effort'  // { reasoning_effort: 'high' | 'none' }
  | 'local_disable_thinking';   // { disable_thinking: bool }

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

const UNKNOWN_CAPS: ReasoningCapabilities = {
  supported: false,
  levels: [],
  paramShape: 'openai_reasoning_effort',
  source: 'unknown'
};

export class BaseProvider {
  name = 'unknown';
  label = 'Unknown';
  supportsStreaming = true;
  _clients = new Map();

  /** Detect if this provider handles the given name/url */
  detect(providerName, baseUrl) { // eslint-disable-line no-unused-vars
    return false;
  }

  /** Create (or return cached) SDK client for this provider */
  createClient(apiKey, baseUrl) { // eslint-disable-line no-unused-vars
    return null;
  }

  /**
   * Stream chat completions via the SDK.
   * Yields { content, reasoning } objects.
   */
  async *streamChat(params) { // eslint-disable-line no-unused-vars
    yield { content: '', reasoning: '' };
  }

  /**
   * Non-streaming chat completion via the SDK.
   * Returns { content, reasoning, usage, toolCalls }.
   */
  async completeChat(params) { // eslint-disable-line no-unused-vars
    return { content: '', reasoning: '', usage: null, toolCalls: null };
  }

  /** Fetch available model list */
  async fetchModels(apiKey, baseUrl) { // eslint-disable-line no-unused-vars
    return [];
  }

  /** Fetch a single model's metadata (returns { context_window } or null) */
  async fetchModelMetadata(apiKey, baseUrl, modelId) { // eslint-disable-line no-unused-vars
    return null;
  }

  /**
   * Declare what reasoning levels this provider/model supports and how to
   * wire them into the native API body. Default: unknown (selector hidden).
   * Override in subclasses using SDK types / API metadata — never guess.
   */
  async getReasoningCapabilities(_apiKey, _baseUrl, _modelId): Promise<ReasoningCapabilities> {
    return { ...UNKNOWN_CAPS };
  }

  /**
   * Apply a reasoning level to a provider-specific request body.
   * Default: no-op. Override in subclasses to translate to native shape.
   */
  applyReasoningToBody(body, _reasoning) {
    return body;
  }

  /**
   * Probe whether the model/provider supports native function calling.
   * Default: makes a lightweight completeChat call with a simple tool.
   * Returns { supportsTools: boolean, source: string }.
   */
  async checkToolSupport({ baseUrl, apiKey, model, providerName, ...rest }) { // eslint-disable-line no-unused-vars
    try {
      const result = await this.completeChat({
        baseUrl,
        apiKey,
        model: model || 'default',
        providerName: providerName || this.name,
        messages: [
          { role: 'system', content: 'You are a helpful assistant. If tools are available, use them when appropriate.' },
          { role: 'user', content: 'What is 2+2? Just return the number.' }
        ],
        tools: [{
          type: 'function',
          function: {
            name: 'calculator',
            description: 'Evaluate a math expression',
            parameters: {
              type: 'object',
              properties: {
                expression: { type: 'string', description: 'Expression to evaluate' }
              },
              required: ['expression']
            }
          }
        }],
        signal: AbortSignal.timeout(12000),
        ...rest
      });
      // If we get a response without an error, assume tools are supported
      const hasTools = !!(result?.toolCalls?.length || result?.content);
      return { supportsTools: hasTools, source: 'probe' };
    } catch (err: unknown) {
      const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
      // Tool-related errors mean the API rejected tools
      if (/tool|function.?call|unsupported|not.?support/i.test(msg)) {
        return { supportsTools: false, source: 'probe_rejected' };
      }
      // Other errors (auth, network, etc.) — assume tools might work, let the agent fall back
      return { supportsTools: true, source: 'probe_fallback' };
    }
  }
}

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
    } catch (err) {
      const msg = String(err?.message || err || '').toLowerCase();
      // Tool-related errors mean the API rejected tools
      if (/tool|function.?call|unsupported|not.?support/i.test(msg)) {
        return { supportsTools: false, source: 'probe_rejected' };
      }
      // Other errors (auth, network, etc.) — assume tools might work, let the agent fall back
      return { supportsTools: true, source: 'probe_fallback' };
    }
  }
}

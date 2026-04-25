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
}

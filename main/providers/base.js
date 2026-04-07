export class BaseProvider {
  name = 'unknown';
  label = 'Unknown';
  supportsStreaming = true;

  /** Detect if this provider handles the given name/url */
  detect(providerName, baseUrl) { // eslint-disable-line no-unused-vars
    return false;
  }

  /** Resolve the chat completions endpoint URL */
  resolveUrl(baseUrl) {
    throw new Error('Not implemented');
  }

  /** Build HTTP headers for a request */
  buildHeaders(apiKey) { // eslint-disable-line no-unused-vars
    return {};
  }

  /** Transform the OpenAI-compatible body for this provider */
  transformBody(body) {
    return body;
  }

  /**
   * Parse a single SSE line → { content, reasoning } | null
   * Return null if the line should be skipped.
   */
  parseStreamDelta(line) { // eslint-disable-line no-unused-vars
    return null;
  }

  /** Parse a non-streaming response → { content, reasoning, usage } */
  parseResponse(data) { // eslint-disable-line no-unused-vars
    return { content: '', reasoning: '', usage: null };
  }

  /** Fetch available model list */
  async fetchModels(apiKey, baseUrl) { // eslint-disable-line no-unused-vars
    return [];
  }
}

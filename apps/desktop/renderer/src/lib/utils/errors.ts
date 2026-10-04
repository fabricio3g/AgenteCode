export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/** Strip Electron IPC wrappers and stacked `Error:` prefixes. */
function cleanIpcError(raw: string): string {
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^(Error:\s*)+/i, '')
    .trim();
}

/** User-facing copy for model-list failures — never raw IPC dumps. */
export function humanizeProviderError(err: unknown): string {
  const cleaned = cleanIpcError(toErrorMessage(err));
  // Machine-shaped blobs carry no words worth showing, even when they hold
  // a digit run a status branch would otherwise match.
  if (!cleaned || /^[{[]/.test(cleaned)) return 'Could not load the model list. Please try again.';
  const lower = cleaned.toLowerCase();

  const missingKey = cleaned.match(/no API key configured for ["']?([\w-]+)/i);
  if (missingKey) {
    const name = missingKey[1];
    const label = name.charAt(0).toUpperCase() + name.slice(1);
    return `No API key for ${label} yet. Add it above, then refresh the list.`;
  }
  if (/timed out|timeout/i.test(cleaned)) {
    return 'Loading the model list took too long. Check the connection and try again.';
  }
  if (/401|403|unauthorized|invalid_api_key|invalid key/i.test(lower)) {
    return 'The provider rejected this key. Check it and try again.';
  }
  if (/429|rate limit|quota|too many requests/i.test(lower)) {
    return 'The provider is rate-limiting requests right now. Wait a moment and try again.';
  }
  if (/5\d{2}|internal server error|bad gateway|service unavailable/i.test(lower)) {
    return 'The provider had a temporary outage. Please try again in a moment.';
  }
  if (/network|fetch failed|econnrefused|enotfound|etimedout|econnreset|socket/i.test(lower)) {
    return 'Could not reach the provider. Check the address and connection, then try again.';
  }
  if (/HTTP\s+\d{3}/i.test(cleaned)) {
    return 'The provider returned an error. Check the address and key, then try again.';
  }
  if (cleaned.length > 180) {
    return 'Could not load the model list. Please try again.';
  }
  return cleaned;
}

/** User-facing copy for agent/tool failures — never raw IPC/API dumps. */
export function humanizeAgentError(err: unknown): string {
  const raw = toErrorMessage(err);
  const lower = raw.toLowerCase();

  if (!raw.trim()) {
    return 'Something went wrong. Please try again.';
  }

  if (isAbortError(err) || /abort|cancell?ed/i.test(raw)) {
    return 'Stopped before finishing.';
  }
  if (/tool_calls|tool_call_id|insufficient tool messages/i.test(raw)) {
    return 'I hit a temporary glitch while using tools. Please try again — I will answer with what I can.';
  }
  if (/context.?length|maximum context|too many tokens|token.?limit|prompt is too long/i.test(lower)) {
    return 'This conversation is too long for the model. Start a new chat or shorten the request.';
  }
  if (/model.?not.?found|unknown model|does not exist|invalid model/i.test(lower)) {
    return 'The selected model is not available. Pick another model in the switcher or Settings.';
  }
  if (/max_tokens|finish_reason.*length|output.?limit/i.test(lower)) {
    return 'The reply hit the length limit before it finished. Ask me to continue.';
  }
  if (/json|parse|unexpected token|malformed/i.test(lower) && /tool|function|argument|schema/i.test(lower)) {
    return 'I could not read a tool response correctly. Please try again.';
  }
  if (/400|422/.test(raw) && /tool|message|format|invalid/i.test(lower)) {
    return 'The model rejected a tool step. Retrying in a simpler way usually helps — please send your request again.';
  }
  if (/401|403|api key|unauthorized|authentication|invalid_api_key/i.test(lower)) {
    return 'The AI provider rejected the request. Check your API key in Settings.';
  }
  if (/429|rate limit|quota|too many requests/i.test(lower)) {
    return 'The provider is rate-limiting requests right now. Wait a moment and try again.';
  }
  if (/5\d{2}|internal server error|bad gateway|service unavailable|gateway timeout/i.test(lower)) {
    return 'The AI provider had a temporary outage. Please try again in a moment.';
  }
  if (/network|fetch failed|econnrefused|enotfound|timeout|etimedout|econnreset|socket/i.test(lower)) {
    return 'I could not reach the service right now. Check your connection and try again.';
  }
  if (/weather|open-meteo/i.test(lower)) {
    return 'I could not reach the weather service right now. Try again in a moment.';
  }
  if (/frankfurter|currency|exchange/i.test(lower)) {
    return 'I could not fetch exchange rates right now. Try again in a moment.';
  }
  if (/quote|stooq|coingecko/i.test(lower)) {
    return 'I could not fetch that market quote right now. Try again in a moment.';
  }
  if (/empty response|no content|no completion/i.test(lower)) {
    return 'The model returned an empty reply. Please try again.';
  }
  if (/unknown finish reason|finish_reason/i.test(lower)) {
    return 'The provider stopped the reply unexpectedly. Please try again.';
  }

  // Strip Electron IPC wrappers and nested Error prefixes
  let cleaned = raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^(Error:\s*)+/i, '')
    .replace(/\btool_call_id\b/gi, 'tool step')
    .trim();

  if (cleaned.length > 180) {
    return 'Something went wrong while generating a reply. Please try again.';
  }
  if (/^[{\[]/.test(cleaned) || /stack|at\s+\w+\s+\(/i.test(cleaned)) {
    return 'Something went wrong while generating a reply. Please try again.';
  }
  if (/tool_call|function\.arguments|openai|anthropic/i.test(cleaned) && cleaned.length > 80) {
    return 'Something went wrong while generating a reply. Please try again.';
  }
  return cleaned || 'Something went wrong. Please try again.';
}

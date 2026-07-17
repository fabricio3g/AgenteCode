export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/** User-facing copy for agent/tool failures — never raw IPC/API dumps. */
export function humanizeAgentError(err: unknown): string {
  const raw = toErrorMessage(err);
  const lower = raw.toLowerCase();

  if (isAbortError(err) || /abort|cancell?ed/i.test(raw)) {
    return 'Stopped before finishing.';
  }
  if (/tool_calls|tool_call_id|insufficient tool messages/i.test(raw)) {
    return 'I hit a temporary glitch while using tools. Please try again — I will answer with what I can.';
  }
  if (/400|422/.test(raw) && /tool|message|format/i.test(lower)) {
    return 'The model rejected a tool step. Retrying in a simpler way usually helps — please send your request again.';
  }
  if (/401|403|api key|unauthorized|authentication/i.test(lower)) {
    return 'The AI provider rejected the request. Check your API key in Settings.';
  }
  if (/429|rate limit|quota/i.test(lower)) {
    return 'The provider is rate-limiting requests right now. Wait a moment and try again.';
  }
  if (/network|fetch failed|econnrefused|enotfound|timeout|etimedout/i.test(lower)) {
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
  // Strip Electron IPC wrappers
  const cleaned = raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim();
  if (cleaned.length > 180) {
    return 'Something went wrong while generating a reply. Please try again.';
  }
  if (/^[{\[]/.test(cleaned) || /stack|at\s+\w+\s+\(/i.test(cleaned)) {
    return 'Something went wrong while generating a reply. Please try again.';
  }
  return cleaned || 'Something went wrong. Please try again.';
}

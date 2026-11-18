export function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

/** Accept either an OpenAI API root or a pasted chat-completions endpoint. */
export function normalizeOpenAiBaseUrl(baseUrl) {
  return normalizeBaseUrl(baseUrl).replace(/\/chat\/completions$/i, '');
}

export function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function safeParseJson(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch { return null; }
}

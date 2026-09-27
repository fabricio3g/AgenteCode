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

export function normalizeRuntimeUsage(usage, timings) {
  const usageRecord = usage && typeof usage === 'object' ? usage : {};
  const timingRecord = timings && typeof timings === 'object'
    ? timings
    : usageRecord.timings && typeof usageRecord.timings === 'object'
      ? usageRecord.timings
      : null;
  if (!Object.keys(usageRecord).length && !timingRecord) return null;
  return {
    ...usageRecord,
    ...(timingRecord ? { timings: timingRecord } : {})
  };
}

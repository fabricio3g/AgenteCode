import { UI_CATALOGS } from '$lib/i18n/catalogs';

export type CodeErrorKind = 'providerUnavailable' | 'internetUnavailable' | 'localModelNotRunning' | 'providerRejected' | 'failed';

const localModelSentences = Object.values(UI_CATALOGS).map((catalog) => catalog.code.runtimeLocalModelNotRunning.toLowerCase());

function providerStatus(detail: string): number | undefined {
  const http = /\bHTTP\s*[:=]?\s*(\d{3})\b/i.exec(detail);
  if (http) return Number(http[1]);
  try {
    const value = JSON.parse(detail.slice(detail.indexOf('{')));
    return value.code ?? value.error?.code;
  } catch { return undefined; }
}

/** Presentation-only classification: keep the engine's original diagnostic intact. */
export function classifyCodeError(detail: string): CodeErrorKind {
  const text = detail.toLowerCase();
  const status = providerStatus(detail);
  if (status !== undefined && status >= 400 && status < 500) return 'providerRejected';
  if (status !== undefined && status >= 500 && status < 600) return 'providerUnavailable';
  if (localModelSentences.some((sentence) => text.includes(sentence))) return 'localModelNotRunning';
  const connectionFailure = /econnrefused|connection refused|failed to connect|connection error|error sending request|fetch failed|failed to fetch|network error|networkerror|broken pipe|stream closed|connection reset|error reading a body|unreachable|timed?\s*out|etimedout/.test(text);
  const localEndpoint = /localhost|127\.0\.0\.1|\[::1\]|\b0\.0\.0\.0\b/.test(text);
  if (/local[_ ]model[_ ]not[_ ]running|local (?:model|runtime|server).*(?:not running|not started|not available|unavailable|could not (?:start|be started)|failed to start)|no (?:running|active) local (?:model|runtime)|llama.*(?:not running|not started)/.test(text)
    || (localEndpoint && connectionFailure)) return 'localModelNotRunning';

  // A gateway can return a successful HTTP envelope containing a provider error.
  if (/provider[_ ]unavailable|provider (?:is )?(?:unavailable|unreachable)|empty response|no endpoints (?:available|found)|bad gateway|service unavailable|experiencing issues|upstream.*(?:unavailable|error|failed)/.test(text)) return 'providerUnavailable';
  if (/internet[_ ]unavailable|internet.*(?:offline|unavailable)|offline|err_internet_disconnected|enotfound|eai_again|enetunreach|ehostunreach|dns|network (?:is )?(?:unavailable|unreachable)|connection refused/.test(text)
    || connectionFailure) return 'internetUnavailable';
  if (/provider[_ ]rejected|request rejected|rejected (?:the )?request|invalid[_ ](?:request|api[_ ]key)|invalid api key|api key invalid|unauthorized|forbidden|authentication|permission denied|rate[_ ]limit|too many requests|insufficient (?:credit|quota)|quota|context (?:length|window)/.test(text)) return 'providerRejected';
  return 'failed';
}

export function codeErrorSummaryKey(detail: string): string {
  const kind = classifyCodeError(detail);
  return kind === 'localModelNotRunning' ? 'code.runtimeLocalModelNotRunning' : `code.errors.${kind}`;
}

/** Older saved errors sometimes put the diagnostic in the answer as well. */
export function withoutCodeErrorText<T extends { text?: string }>(entries: T[], errorDetail?: string): T[] {
  return entries.filter((entry) => !(errorDetail && entry.text?.trim() === errorDetail.trim()));
}

/** Diagnostics remain useful, but credentials echoed by a provider must never render. */
export function safeCodeErrorDetails(detail: string): string {
  return detail
    .replace(/\b(?:sk|rk|pk)-[a-z0-9_-]{8,}/gi, '[redacted]')
    .replace(/(\b(?:authorization|proxy-authorization)\b["']?\s*[:=]\s*["']?)(?:bearer\s+|basic\s+)?[^\s,"'}]+/gi, '$1[redacted]')
    .replace(/\b(bearer\s+)[^\s,"'}]+/gi, '$1[redacted]')
    .replace(/(["']?\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)\b["']?\s*[:=]\s*["']?)[^\s,"'&}]+/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@');
}

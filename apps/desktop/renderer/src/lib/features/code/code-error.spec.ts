import { describe, expect, it } from 'vitest';
import { classifyCodeError, safeCodeErrorDetails, withoutCodeErrorText } from './code-error';
import { orderedEntries } from './code-run';
import en from '$lib/locales/en.json';
import es from '$lib/locales/es.json';
import pt from '$lib/locales/pt-BR.json';
import fr from '$lib/locales/fr.json';
import de from '$lib/locales/de.json';
import ja from '$lib/locales/ja.json';
import zh from '$lib/locales/zh.json';

describe('Code error presentation', () => {
  it.each([
    ['OpenRouter: {"error":{"code":502,"message":"Provider returned error","metadata":{"raw":"{\\"error\\":\\"provider_unavailable\\"}"}}}', 'providerUnavailable'],
    ['OpenRouter: Provider returned an empty response', 'providerUnavailable'],
    ['HTTP 503 Service Unavailable', 'providerUnavailable'],
    ['Provider is unavailable', 'providerUnavailable'],
    ['TypeError: Failed to fetch', 'internetUnavailable'],
    ['error sending request for url (https://api.example.com/v1/chat): dns error: ENOTFOUND', 'internetUnavailable'],
    ['Network is unreachable (ENETUNREACH)', 'internetUnavailable'],
    ['local_model_not_running', 'localModelNotRunning'],
    ['The local runtime is not running', 'localModelNotRunning'],
    ['The local model could not be started', 'localModelNotRunning'],
    ['error sending request for url (http://127.0.0.1:8080/v1/chat/completions): Connection refused', 'localModelNotRunning'],
    ['fetch failed: ECONNREFUSED ::1 http://[::1]:8080', 'localModelNotRunning'],
    ['401: Invalid API key', 'providerRejected'],
    ['HTTP 429: rate limit exceeded', 'providerRejected'],
    ['Provider rejected request: invalid_request_error', 'providerRejected'],
    ['Failed to start the coding agent.', 'failed'],
    ['', 'failed'],
  ])('classifies %s', (detail, kind) => {
    expect(classifyCodeError(detail)).toBe(kind);
  });

  it('does not mistake a local provider rejection for a stopped local model', () => {
    expect(classifyCodeError('HTTP 400 from http://localhost:8080: invalid request')).toBe('providerRejected');
  });

  it('recognizes main-process local-model failures across all Electron locales', () => {
    for (const catalog of [en, es, pt, fr, de, ja, zh]) {
      expect(classifyCodeError(`Error invoking remote method: ${catalog.code.runtimeLocalModelNotRunning}`)).toBe('localModelNotRunning');
    }
  });

  it('prefers provider status over body text and ignores digits in model ids', () => {
    expect(classifyCodeError('HTTP 400: provider_unavailable')).toBe('providerRejected');
    expect(classifyCodeError('openrouter: {"code":401,"message":"empty response"}')).toBe('providerRejected');
    expect(classifyCodeError('Model gpt-500 returned no usable output')).toBe('failed');
  });

  it('preserves raw diagnostics without exposing echoed credentials', () => {
    const detail = 'HTTP 502: provider_unavailable; Authorization: Bearer example-secret; {"api_key":"example-key","token":"example-token"}; https://user:example-password@api.example.com?access_token=example-access; sk-testcredential123';
    const safe = safeCodeErrorDetails(detail);
    for (const secret of ['example-secret', 'example-key', 'example-token', 'example-password', 'example-access', 'sk-testcredential123']) expect(safe).not.toContain(secret);
    expect(safe).toContain('HTTP 502: provider_unavailable');
    expect(safeCodeErrorDetails('OpenRouter {"code":502,"message":"empty response"}')).toBe('OpenRouter {"code":502,"message":"empty response"}');
  });

  it('keeps partial answers and tool work while moving duplicated saved diagnostics into Details', () => {
    const detail = 'OpenRouter {"code":502,"message":"empty response"}';
    const message = {
      content: detail,
      agentSteps: [{ id: 'read', type: 'tool' as const, label: 'Read file', status: 'done' as const }],
      metadata: { codeTimeline: [{ kind: 'text' as const, text: 'I found the relevant file.' }, { kind: 'step' as const, id: 'read' }, { kind: 'text' as const, text: detail }] },
    };
    const entries = withoutCodeErrorText(orderedEntries(message), detail);
    expect(entries).toHaveLength(2);
    expect(entries[0].text).toBe('I found the relevant file.');
    expect(entries[1].step?.id).toBe('read');
    expect(withoutCodeErrorText(orderedEntries({ content: detail }), detail)).toEqual([]);
    expect(withoutCodeErrorText(orderedEntries({ content: 'Normal answer' }))).toMatchObject([{ text: 'Normal answer' }]);
  });
});

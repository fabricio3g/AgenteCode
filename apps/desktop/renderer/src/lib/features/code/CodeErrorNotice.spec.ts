// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { addMessages, init, locale } from 'svelte-i18n';
import CodeErrorNotice from './CodeErrorNotice.svelte';

const locales = import.meta.glob<{ default: { code: { errors: Record<string, string>; runtimeLocalModelNotRunning: string } } }>('../../locales/*.json', { eager: true });
for (const [path, messages] of Object.entries(locales)) addMessages(path.split('/').pop()!.replace('.json', ''), messages.default);
init({ fallbackLocale: 'en', initialLocale: 'en' });
afterEach(cleanup);

describe('Code error notice', () => {
  for (const [path, messages] of Object.entries(locales)) {
    const language = path.split('/').pop()!.replace('.json', '');
    it(`shows a localized summary and closed Details in ${language}`, async () => {
      await locale.set(language);
      const detail = 'OpenRouter {"code":502,"error":"provider_unavailable","message":"empty response"}';
      const view = render(CodeErrorNotice, { detail });
      expect(view.getByRole('alert').textContent).toContain(messages.default.code.errors.providerUnavailable);
      expect(view.getByText(messages.default.code.errors.details).tagName).toBe('SUMMARY');
      const disclosure = view.container.querySelector('details')!;
      expect(disclosure.open).toBe(false);
      disclosure.open = true;
      expect(disclosure.querySelector('pre')!.textContent).toBe(detail);
    });
    it(`uses the active UI locale for local model errors in ${language}`, async () => {
      await locale.set(language);
      const detail = "The local model isn't running — load it from Models.";
      const view = render(CodeErrorNotice, { detail });
      expect(view.getByRole('alert').querySelector('p')!.textContent).toBe(messages.default.code.runtimeLocalModelNotRunning);
      expect(view.container.querySelector('details')!.open).toBe(false);
    });
  }

  it('never inserts provider diagnostics as HTML or displays credentials', async () => {
    await locale.set('en');
    const view = render(CodeErrorNotice, { detail: 'HTTP 502 <img src=x onerror=alert(1)> Authorization: Bearer example-credential' });
    expect(view.container.querySelector('img')).toBeNull();
    expect(view.container.textContent).not.toContain('example-credential');
    expect(view.container.querySelector('pre')!.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

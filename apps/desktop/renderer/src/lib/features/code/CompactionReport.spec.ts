// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, expect, it } from 'vitest';
import CompactionReport from './CompactionReport.svelte';
afterEach(cleanup);
it('shows before/after context and actual model/cache usage', () => {
  const { container } = render(CompactionReport, { report: { running: false, success: true, tokensBefore: 12000, tokensAfter: 4000, smart: true, requestedSmart: true, modelTokens: 800, cacheReadTokens: 200 } });
  // `toLocaleString` follows the machine, so the separators are not the point.
  expect(container.textContent).toMatch(/12[.,\s]?000\s*→\s*~4[.,\s]?000/);
  expect(container.textContent).toContain('800');
  expect(container.textContent).toContain('200');
});
it('does not invent model usage when the provider did not report it', () => {
  const { container } = render(CompactionReport, { report: { running: false, success: true, smart: true, requestedSmart: true } });
  expect(container.textContent).toContain('not reported');
  expect(container.textContent).not.toContain('0 tokens');
});

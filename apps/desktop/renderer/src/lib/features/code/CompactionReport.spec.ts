// @vitest-environment jsdom
import { cleanup, render, fireEvent } from '@testing-library/svelte';
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

it('renders the actual checkpoint on demand without inventing a summary for trimming', async () => {
  const { container } = render(CompactionReport, { report: { running: false, success: true, smart: true, summary: '## Pending work\n\nKeep the selected model and test `src/main.rs`.' } });
  expect(container.textContent).not.toContain('Pending work');
  const details = container.querySelector('details')!;
  details.open = true;
  await fireEvent(details, new Event('toggle'));
  expect(container.querySelector('h2')?.textContent).toBe('Pending work');
  expect(container.textContent).toContain('src/main.rs');
  cleanup();
  const trimmed = render(CompactionReport, { report: { running: false, success: true, smart: false, summary: 'Not a model checkpoint' } });
  const trimDetails = trimmed.container.querySelector('details')!;
  trimDetails.open = true;
  await fireEvent(trimDetails, new Event('toggle'));
  expect(trimmed.container.textContent).not.toContain('Not a model checkpoint');
});

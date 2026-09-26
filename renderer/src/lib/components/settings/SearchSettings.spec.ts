// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SearchSettings from './SearchSettings.svelte';

vi.mock('$lib/services/search', () => ({
  getAggregatorCatalog: vi.fn(async () => [
    {
      id: 'wikipedia',
      label: 'Wikipedia',
      category: 'recommended',
      transport: 'json',
      stability: 'stable',
      requires: [],
      recommended: true,
      supports_safe_search: true,
      timeout_ms: 5000,
    },
    {
      id: 'private-meta',
      label: 'Private Meta',
      category: 'self_hosted',
      transport: 'json',
      stability: 'stable',
      requires: ['base_url'],
      recommended: false,
      supports_safe_search: true,
      timeout_ms: 5000,
      default_base_url: '',
    },
  ]),
  probeAggregatorEngines: vi.fn(async () => ({ engine_attempts: [] })),
}));

afterEach(cleanup);

function renderSearch(provider = 'aggregator') {
  return render(SearchSettings, {
    props: {
      searchProvider: provider,
      searchMaxResults: '6',
      searchApiKey: '',
      searchBaseUrl: '',
      searchModel: 'sonar',
      searchApiUrl: 'https://api.perplexity.ai',
      aggregatorEngines: ['wikipedia'],
      searchSafeSearch: '2',
      aggregatorProviders: {},
      onSaveConfiguration: vi.fn(async () => undefined),
      savingConfiguration: false,
    },
  });
}

describe('SearchSettings', () => {
  it('shows engine controls only for the aggregator and blocks an empty pool', async () => {
    const view = renderSearch();
    expect(await view.findByText('Engine pool')).toBeTruthy();

    await fireEvent.click(await view.findByRole('switch', { name: 'Disable Wikipedia' }));
    expect(await view.findByText(/Enable at least one engine/)).toBeTruthy();

    cleanup();
    const direct = renderSearch('tavily');
    expect(direct.queryByText('Engine pool')).toBeNull();
  });

  it('keeps a configured engine disabled until the user enables it', async () => {
    const view = renderSearch();
    await view.findByText('Private Meta');
    const unavailable = view.getByRole('switch', { name: 'Enable Private Meta' }) as HTMLButtonElement;
    expect(unavailable.disabled).toBe(true);

    await fireEvent.click(view.getByRole('button', { name: /Configure/ }));
    const input = view.getByLabelText('Base URL');
    await fireEvent.input(input, { target: { value: 'https://search.internal' } });

    await waitFor(() => {
      const available = view.getByRole('switch', { name: 'Enable Private Meta' }) as HTMLButtonElement;
      expect(available.disabled).toBe(false);
      expect(available.getAttribute('aria-checked')).toBe('false');
    });
  });

  it('keeps bulk actions in the action menu', async () => {
    const view = renderSearch();
    await view.findByText('Wikipedia');
    await fireEvent.click(view.getByRole('button', { name: 'Engine pool actions' }));
    expect(view.getByRole('button', { name: 'Enable recommended' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Enable all configured' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Disable all' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Reset to recommended' })).toBeTruthy();
  });
});

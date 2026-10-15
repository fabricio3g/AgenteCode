// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import ModelSwitcher from './ModelSwitcher.svelte';
const mocks = vi.hoisted(() => ({
  app: { config: { llm: { provider: 'test', providers: { test: { model: 'selected', has_api_key: true } } } },
    activeProvider: { model: 'selected', has_api_key: true }, activeProviderName: 'test', activeModelLabel: 'Selected',
    backendMode: 'api', modelMenuOpen: true, models: [], modelsRefreshing: false,
    updateProvider: vi.fn(async () => {}), setBackendMode: vi.fn(async () => {}), openSettings: vi.fn() },
  load: vi.fn(async () => {}),
  models: Array.from({ length: 100 }, (_, i) => ({ id: i ? `model-${i}` : 'selected', name: i ? `Model ${i}` : 'Selected', source: 'api' }))
}));
vi.mock('$lib/stores/app.svelte', () => ({ appStore: mocks.app }));
vi.mock('$lib/stores/models.svelte', () => ({ modelsStore: { refreshStatus: vi.fn() } }));
vi.mock('$lib/stores/provider-models.svelte', () => ({ providerModels: { models: () => mocks.models, load: mocks.load, loading: {}, errors: {} } }));
vi.mock('$lib/utils/providers', () => ({ configuredProviders: () => [{ id: 'test', label: 'Test provider', model: 'selected', isActive: true }], defaultBaseUrl: () => 'https://provider.test' }));
vi.mock('$lib/services/bridge', () => ({ isElectron: () => true, invoke: vi.fn() }));
vi.mock('$lib/stores/toast.svelte', () => ({ toastStore: { error: vi.fn(), success: vi.fn() } }));
afterEach(() => { cleanup(); mocks.app.modelMenuOpen = true; vi.clearAllMocks(); });
it('opens the active provider and bounds initial rows, while search reaches every model', async () => {
  const { container } = render(ModelSwitcher, { props: { open: true } });
  await waitFor(() => expect(container.ownerDocument.querySelectorAll('[data-model-option]')).toHaveLength(50));
  const input = document.querySelector<HTMLInputElement>('input[type="search"]')!;
  await fireEvent.input(input, { target: { value: 'Model 99' } });
  await waitFor(() => expect(document.querySelectorAll('[data-model-option]')).toHaveLength(1));
  await fireEvent.click(document.querySelector('[data-model-option]')!);
  await waitFor(() => expect(mocks.app.updateProvider).toHaveBeenCalledWith({ provider: 'test', base_url: 'https://provider.test', model: 'model-99' }));
});
it('arrow navigation reaches an immediately available model row', async () => {
  render(ModelSwitcher, { props: { open: true } });
  await waitFor(() => expect(document.querySelectorAll('[data-model-option]')).toHaveLength(50));
  const input = document.querySelector<HTMLInputElement>('input[type="search"]')!;
  input.focus();
  HTMLElement.prototype.scrollIntoView ??= vi.fn();
  await fireEvent.keyDown(input, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(document.querySelector('[data-model-option]'));
});

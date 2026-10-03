// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Cpu, Search } from 'lucide-svelte';
import SettingsRail, { type RailGroup } from './SettingsRail.svelte';

// The rail reaches for the model library and the store only in the import
// action; the nav itself needs neither.
vi.mock('$lib/services/files', () => ({ openModelsFolder: vi.fn(), pickModelFile: vi.fn(async () => null) }));
vi.mock('$lib/services/models', () => ({ importLocalModel: vi.fn(async () => undefined) }));
vi.mock('$lib/stores/app.svelte', () => ({
  appStore: { refreshModels: vi.fn(async () => undefined), config: { llm: {} } }
}));
vi.mock('$lib/stores/models.svelte', () => ({ modelsStore: { status: null, refreshIndex: vi.fn(async () => undefined) } }));

afterEach(cleanup);

const groups: RailGroup[] = [
  {
    id: 'models',
    title: 'Models',
    items: [
      { kind: 'tab', id: 'discover', label: 'Explore', icon: Search },
      { kind: 'tab', id: 'library', label: 'Library', icon: Search, count: 2 }
    ]
  },
  {
    id: 'preferences',
    title: 'Preferences',
    items: [
      { kind: 'section', id: 'general', label: 'General', icon: Cpu },
      { kind: 'section', id: 'local', label: 'On this computer', icon: Cpu, dot: true },
      { kind: 'section', id: 'voice', label: 'Voice', icon: Cpu }
    ]
  },
  {
    id: 'providers',
    title: 'Model providers',
    items: [],
    subgroups: [
      { title: 'Cloud', items: [{ kind: 'provider', id: 'openai', label: 'OpenAI', status: 'in-use' }] },
      { title: 'On this computer', items: [{ kind: 'provider', id: 'ollama', label: 'Ollama', status: 'none' }] }
    ]
  }
];

function renderRail(selected = 'section:general') {
  const onselect = vi.fn();
  const view = render(SettingsRail, {
    props: {
      groups,
      selected,
      autoLoad: false,
      onselect,
      onautoload: vi.fn(),
      onaddendpoint: vi.fn()
    }
  });
  return { view, onselect };
}

describe('SettingsRail', () => {
  it('renders every group in one column and marks the row on screen', () => {
    const { view } = renderRail();
    expect(view.getByText('Models')).toBeTruthy();
    expect(view.getByText('Preferences')).toBeTruthy();
    expect(view.getByText('Model providers')).toBeTruthy();
    // Both model tabs and both provider rows live in the same rail now.
    expect(view.getByRole('button', { name: /Explore/ })).toBeTruthy();
    expect(view.getByRole('button', { name: /Library/ })).toBeTruthy();
    expect(view.getByRole('button', { name: /OpenAI/ })).toBeTruthy();

    const current = view.getAllByRole('button').filter((row) => row.getAttribute('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toContain('General');
  });

  it('reports the row, not the section, so a provider can be picked directly', async () => {
    const { view, onselect } = renderRail();
    await fireEvent.click(view.getByRole('button', { name: /Ollama/ }));
    expect(onselect).toHaveBeenCalledWith(expect.objectContaining({ kind: 'provider', id: 'ollama' }));

    await fireEvent.click(view.getByRole('button', { name: /Library/ }));
    expect(onselect).toHaveBeenCalledWith(expect.objectContaining({ kind: 'tab', id: 'library' }));
  });

  it('filters the rail and says so when nothing matches', async () => {
    const { view } = renderRail();
    const filter = view.getByLabelText('Filter sections');
    await fireEvent.input(filter, { target: { value: 'voi' } });

    expect(view.queryByRole('button', { name: /Explore/ })).toBeNull();
    expect(view.getByRole('button', { name: /Voice/ })).toBeTruthy();

    await fireEvent.input(filter, { target: { value: 'zzz' } });
    expect(view.getByText('No matching sections')).toBeTruthy();
  });

  it('walks the rows with the arrow keys', async () => {
    const { view } = renderRail();
    const first = view.getByRole('button', { name: /Explore/ });
    first.focus();
    await fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toContain('Library');
    await fireEvent.keyDown(first, { key: 'End' });
    expect(document.activeElement?.textContent).toContain('Import .gguf');
  });
});
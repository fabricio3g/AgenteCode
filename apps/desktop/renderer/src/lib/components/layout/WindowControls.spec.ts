// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WindowControls from './WindowControls.svelte';

type Bridge = Record<string, unknown>;

/** The preload bridge, reduced to the window calls these buttons make. */
function installBridge(platform: string, overrides: Bridge = {}) {
  const api = {
    platform,
    isElectron: true,
    windowMinimize: vi.fn(() => Promise.resolve()),
    windowToggleMaximize: vi.fn(() => Promise.resolve()),
    windowIsMaximized: vi.fn(() => Promise.resolve(false)),
    windowClose: vi.fn(() => Promise.resolve()),
    windowRequestClose: vi.fn(() => Promise.resolve({ closed: true, prompted: false })),
    ...overrides,
  };
  (window as unknown as { electronAPI: Bridge }).electronAPI = api;
  return api;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as unknown as { electronAPI?: Bridge }).electronAPI;
});

describe('window controls', () => {
  it('draws minimize, maximize and close with accessible names', () => {
    installBridge('win32');
    const view = render(WindowControls);

    const buttons = view.getAllByRole('button');
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(['Minimize', 'Maximize', 'Close']);
    // A group, so "Close" here never reads as the conversation's close.
    expect(view.getByRole('group', { name: 'Window' })).toBeTruthy();
  });

  it('is left to macOS, which keeps its own traffic lights', () => {
    installBridge('darwin');
    const view = render(WindowControls);
    expect(view.queryAllByRole('button')).toHaveLength(0);
  });

  it('minimizes and closes through the bridge', async () => {
    const api = installBridge('linux');
    const view = render(WindowControls);

    await fireEvent.click(view.getByRole('button', { name: 'Minimize' }));
    expect(api.windowMinimize).toHaveBeenCalled();

    await fireEvent.click(view.getByRole('button', { name: 'Close' }));
    expect(api.windowRequestClose).toHaveBeenCalled();
  });

  it('reads the maximized state back and offers restore', async () => {
    let maximized = false;
    const api = installBridge('win32', {
      windowIsMaximized: vi.fn(() => Promise.resolve(maximized)),
      windowToggleMaximize: vi.fn(() => {
        maximized = true;
        return Promise.resolve();
      }),
    });
    const view = render(WindowControls);
    // The mount query lands after the first paint.
    await vi.waitFor(() => expect(view.getByRole('button', { name: 'Maximize' })).toBeTruthy());

    await fireEvent.click(view.getByRole('button', { name: 'Maximize' }));
    expect(api.windowToggleMaximize).toHaveBeenCalled();
    await vi.waitFor(() => expect(view.getByRole('button', { name: 'Restore' })).toBeTruthy());
  });
});

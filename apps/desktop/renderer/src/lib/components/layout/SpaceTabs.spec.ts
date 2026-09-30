// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appStore } from '$lib/stores/app.svelte';
import SpaceTabs from './SpaceTabs.svelte';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('top-bar space tabs', () => {
  it('always exposes named icon tabs and supports roving keyboard focus', async () => {
    appStore.activeSpace = 'home';
    appStore.config = { ...appStore.config, ui: { ...appStore.config.ui, roleplay_enabled: false } };
    vi.spyOn(appStore, 'setActiveSpace').mockImplementation((space) => { appStore.activeSpace = space; });
    const enable = vi.spyOn(appStore, 'setRoleplayEnabled').mockResolvedValue(undefined);
    const view = render(SpaceTabs);
    expect(view.getAllByRole('tab')).toHaveLength(3);
    const home = view.getByRole('tab', { name: 'Home' });
    const code = view.getByRole('tab', { name: 'Code' });
    const roleplay = view.getByRole('tab', { name: 'Roleplay' });
    home.focus();
    await fireEvent.keyDown(home, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(code);
    expect(code.getAttribute('aria-selected')).toBe('true');
    await fireEvent.keyDown(code, { key: 'End' });
    expect(document.activeElement).toBe(roleplay);
    expect(enable).toHaveBeenCalledWith(true);
    expect(roleplay.textContent?.trim()).toBe('');
  });

  it('enables Roleplay by default for unset preferences', () => {
    appStore.config = { ...appStore.config, ui: { ...appStore.config.ui, roleplay_enabled: undefined } };
    expect(appStore.roleplayEnabled).toBe(true);
  });
});

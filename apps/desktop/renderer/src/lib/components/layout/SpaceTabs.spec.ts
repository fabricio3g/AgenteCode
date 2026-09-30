// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appStore } from '$lib/stores/app.svelte';
import SpaceTabs from './SpaceTabs.svelte';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('top-bar space tabs', () => {
  it('always exposes named icon tabs and supports roving keyboard focus', async () => {
    appStore.activeSpace = 'home';
    appStore.botsOpen = false;
    appStore.config = { ...appStore.config, ui: { ...appStore.config.ui, roleplay_enabled: false } };
    vi.spyOn(appStore, 'setActiveSpace').mockImplementation((space) => { appStore.botsOpen = false; appStore.activeSpace = space; });
    vi.spyOn(appStore, 'persist').mockImplementation(() => {});
    const enable = vi.spyOn(appStore, 'setRoleplayEnabled').mockResolvedValue(undefined);
    const view = render(SpaceTabs);
    expect(view.getAllByRole('tab')).toHaveLength(4);
    const home = view.getByRole('tab', { name: 'Home' });
    const code = view.getByRole('tab', { name: 'Code' });
    const roleplay = view.getByRole('tab', { name: 'Roleplay' });
    const bots = view.getByRole('tab', { name: 'Bots' });
    home.focus();
    await fireEvent.keyDown(home, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(code);
    expect(code.getAttribute('aria-selected')).toBe('true');
    await fireEvent.keyDown(code, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(roleplay);
    expect(enable).toHaveBeenCalledWith(true);
    expect(roleplay.textContent?.trim()).toBe('');
    await fireEvent.keyDown(roleplay, { key: 'End' });
    expect(document.activeElement).toBe(bots);
    expect(appStore.activeTab).toBe('bots');
    expect(bots.getAttribute('aria-selected')).toBe('true');
    await fireEvent.keyDown(bots, { key: 'Home' });
    expect(appStore.activeTab).toBe('home');
  });

  it('enables Roleplay by default for unset preferences', () => {
    appStore.config = { ...appStore.config, ui: { ...appStore.config.ui, roleplay_enabled: undefined } };
    expect(appStore.roleplayEnabled).toBe(true);
  });
});

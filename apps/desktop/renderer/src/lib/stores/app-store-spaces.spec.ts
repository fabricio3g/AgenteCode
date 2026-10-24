// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appStore } from '$lib/stores/app.svelte';

/**
 * Home, Code and Design are the app's own spaces. Bots and Roleplay are niche
 * ones, so they ship off and only the Settings switch turns them on; nothing
 * may put the window in a space the person has not asked for.
 */

afterEach(() => {
  vi.restoreAllMocks();
  appStore.config = {};
  appStore.activeSpace = 'home';
  appStore.botsOpen = false;
  appStore.settingsScreenOpen = false;
});

describe('opt-in spaces', () => {
  it('counts a space as on only when Settings wrote the flag', () => {
    expect(appStore.roleplayEnabled).toBe(false);
    expect(appStore.botsEnabled).toBe(false);
    expect(appStore.spaceEnabled('home')).toBe(true);
    expect(appStore.spaceEnabled('code')).toBe(true);
    expect(appStore.spaceEnabled('design')).toBe(true);
    expect(appStore.spaceEnabled('roleplay')).toBe(false);
    expect(appStore.spaceEnabled('bots')).toBe(false);

    appStore.config = { ui: { roleplay_enabled: true, bots_enabled: true } };
    expect(appStore.spaceEnabled('roleplay')).toBe(true);
    expect(appStore.spaceEnabled('bots')).toBe(true);
  });

  it('refuses to open a space that is switched off', () => {
    vi.spyOn(appStore, 'persist').mockImplementation(() => {});
    appStore.setActiveSpace('roleplay');
    expect(appStore.activeSpace).toBe('home');
    appStore.showBots();
    expect(appStore.botsOpen).toBe(false);
  });

  it('opens the space once the switch is on', () => {
    vi.spyOn(appStore, 'persist').mockImplementation(() => {});
    appStore.config = { ui: { roleplay_enabled: true, bots_enabled: true } };
    appStore.setActiveSpace('roleplay');
    expect(appStore.activeSpace).toBe('roleplay');
    appStore.showBots();
    expect(appStore.botsOpen).toBe(true);
  });
});

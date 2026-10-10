// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appStore } from '$lib/stores/app.svelte';
import ActivityRail from './ActivityRail.svelte';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  appStore.botsOpen = false;
  appStore.settingsScreenOpen = false;
});

describe('activity rail', () => {
  it('keeps spaces and settings in one always-on strip with roving focus', async () => {
    appStore.activeSpace = 'home';
    appStore.botsOpen = false;
    appStore.settingsScreenOpen = false;
    appStore.config = { ...appStore.config, ui: { ...appStore.config.ui, roleplay_enabled: false } };
    vi.spyOn(appStore, 'setActiveSpace').mockImplementation((space) => {
      appStore.botsOpen = false;
      appStore.activeSpace = space;
    });
    vi.spyOn(appStore, 'showBots').mockImplementation(() => {
      appStore.botsOpen = true;
    });
    vi.spyOn(appStore, 'persist').mockImplementation(() => {});
    const enable = vi.spyOn(appStore, 'setRoleplayEnabled').mockResolvedValue(undefined);
    const openSettings = vi.spyOn(appStore, 'openSettings').mockImplementation(() => {
      appStore.settingsScreenOpen = true;
    });

    const view = render(ActivityRail);
    expect(view.container.querySelector('[data-activity-rail]')).toBeTruthy();

    // Spaces stay icon-only tabs with hover tooltips, like the titlebar tabs did.
    const tabs = view.getAllByRole('tab');
    expect(tabs).toHaveLength(5);
    const home = view.getByRole('tab', { name: 'Home' });
    const code = view.getByRole('tab', { name: 'Code' });
    const roleplay = view.getByRole('tab', { name: 'Roleplay' });
    const bots = view.getByRole('tab', { name: 'Bots' });
    home.focus();
    await fireEvent.keyDown(home, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(code);
    expect(code.getAttribute('aria-selected')).toBe('true');
    await fireEvent.keyDown(code, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(roleplay);
    expect(enable).toHaveBeenCalledWith(true);
    await fireEvent.keyDown(roleplay, { key: 'End' });
    expect(document.activeElement).toBe(bots);
    expect(appStore.activeTab).toBe('bots');
    await fireEvent.keyDown(bots, { key: 'Home' });
    expect(appStore.activeTab).toBe('home');

    // The sidebar settings entry moved here; downloads and theme ride the
    // titlebar right, clear of the OS caption buttons.
    const settings = view.getByRole('button', { name: 'Settings' });
    await fireEvent.click(settings);
    expect(openSettings).toHaveBeenCalledWith('general');
    expect(view.queryByRole('button', { name: 'Downloads' })).toBeNull();
    expect(view.queryByRole('button', { name: 'Light or dark theme' })).toBeNull();

    // Settings anchors the rail bottom.
    const bottomLabels = Array.from(view.container.querySelectorAll('.rail-bottom button')).map(
      (button) => button.getAttribute('aria-label')
    );
    expect(bottomLabels).toEqual(['Settings']);

    // Every rail icon explains itself on hover through the shared tooltip.
    const anchors = view.container.querySelectorAll('.tooltip-anchor');
    expect(anchors.length).toBeGreaterThanOrEqual(5);
  });

  it('sizes the strip from the chrome tokens instead of its own pixels', () => {
    const modules = import.meta.glob<string>('./ActivityRail.svelte', { query: '?raw', import: 'default', eager: true });
    const rail = modules['./ActivityRail.svelte'];
    // The rail's geometry lives in app.css (--rail-w / --rail-btn / --rail-icon).
    // A second copy here is exactly how the icon ended up rendering at the
    // chrome's 14px: a `size-4` utility lost to `.ui-icon-button svg` on
    // specificity, and nothing failed while the strip looked wrong.
    expect(rail).toContain('var(--rail-w)');
    expect(rail).toContain('var(--rail-btn)');
    expect(rail).toContain('var(--rail-icon)');
    const markup = rail.slice(0, rail.indexOf('<style>'));
    const style = rail.slice(rail.indexOf('<style>'));
    expect(markup).not.toContain('size-4');
    // `(?:^|[\s;{])` so a hardcoded size is caught but `stroke-width:` is not.
    expect(style).not.toMatch(/(?:^|[\s;{])(?:width|height):\s*[\d.]/m);

    // The floating sidebar preview starts beside the rail, so it reads the same
    // token rather than a copy of the width that goes stale on the next tune.
    const shell = import.meta.glob<string>('./AppShell.svelte', { query: '?raw', import: 'default', eager: true });
    expect(shell['./AppShell.svelte']).toContain('left: var(--rail-w)');
    expect(shell['./AppShell.svelte']).not.toContain('left: 3rem');
  });

  it('marks settings pressed while the settings screen is open', () => {
    appStore.settingsScreenOpen = true;
    const view = render(ActivityRail);
    expect(view.getByRole('button', { name: 'Settings' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps downloads and theme in the titlebar, clear of the caption buttons', async () => {
    const modules = import.meta.glob<string>('./Titlebar.svelte', { query: '?raw', import: 'default', eager: true });
    const titlebar = modules['./Titlebar.svelte'];
    expect(titlebar).toContain('<DownloadsButton />');
    expect(titlebar).toContain("{$t('titlebar.theme')}");
    // Clearance is measured live from the overlay rect and kept fresh on
    // resize + geometrychange: exact for any caption width, never stale.
    expect(titlebar).toContain('getTitlebarAreaRect');
    expect(titlebar).toContain('geometrychange');
    expect(titlebar).toContain('--caption-reserve');
    expect(titlebar).not.toContain('max(9rem,');
    expect(titlebar).not.toContain('titlebar-area-width');
  });
});

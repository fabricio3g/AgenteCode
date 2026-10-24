// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appStore } from '$lib/stores/app.svelte';
import SpaceSwitcher from './SpaceSwitcher.svelte';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  appStore.botsOpen = false;
  appStore.settingsScreenOpen = false;
});

describe('space switcher', () => {
  it('heads the sidebar with the spaces in order, as one row of tabs with roving focus', async () => {
    appStore.activeSpace = 'home';
    appStore.botsOpen = false;
    appStore.settingsScreenOpen = false;
    appStore.config = { ...appStore.config, ui: { ...appStore.config.ui, roleplay_enabled: true, bots_enabled: true } };
    vi.spyOn(appStore, 'setActiveSpace').mockImplementation((space) => {
      appStore.botsOpen = false;
      appStore.activeSpace = space;
    });
    vi.spyOn(appStore, 'showBots').mockImplementation(() => {
      appStore.botsOpen = true;
    });
    vi.spyOn(appStore, 'persist').mockImplementation(() => {});

    const view = render(SpaceSwitcher);
    expect(view.container.querySelector('[data-space-switcher]')).toBeTruthy();
    // No app mark: the row is the spaces and nothing else.
    expect(view.container.querySelector('img')).toBeNull();

    // The core spaces first; the two Settings can switch off last.
    const tabs = view.getAllByRole('tab');
    expect(tabs.map((tab) => tab.getAttribute('aria-label'))).toEqual(['Home', 'Code', 'Design', 'Bots', 'Roleplay']);
    const [home, code, design, bots, roleplay] = tabs;
    home.focus();
    await fireEvent.keyDown(home, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(code);
    expect(code.getAttribute('aria-selected')).toBe('true');
    await fireEvent.keyDown(code, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(design);
    await fireEvent.keyDown(design, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(bots);
    expect(appStore.activeTab).toBe('bots');
    await fireEvent.keyDown(bots, { key: 'End' });
    expect(document.activeElement).toBe(roleplay);
    await fireEvent.keyDown(roleplay, { key: 'Home' });
    expect(appStore.activeTab).toBe('home');

    // Settings is the sidebar footer's row, not one of these tabs.
    expect(view.queryByRole('button', { name: 'Settings' })).toBeNull();

    // Every glyph explains itself on hover through the shared tooltip.
    const anchors = view.container.querySelectorAll('.tooltip-anchor');
    expect(anchors.length).toBeGreaterThanOrEqual(5);
  });

  it('leaves out Bots and Roleplay when Settings switches them off', () => {
    appStore.activeSpace = 'home';
    appStore.config = { ...appStore.config, ui: { ...appStore.config.ui, roleplay_enabled: false, bots_enabled: false } };
    const view = render(SpaceSwitcher);
    expect(view.getAllByRole('tab').map((tab) => tab.getAttribute('aria-label'))).toEqual(['Home', 'Code', 'Design']);
  });

  it('ships without Bots and Roleplay: a config that never mentioned them is three tabs', () => {
    appStore.activeSpace = 'home';
    const { roleplay_enabled, bots_enabled, ...ui } = appStore.config.ui ?? {};
    appStore.config = { ...appStore.config, ui };
    const view = render(SpaceSwitcher);
    expect(view.getAllByRole('tab').map((tab) => tab.getAttribute('aria-label'))).toEqual(['Home', 'Code', 'Design']);
  });

  it('closes the floating preview when a space is chosen', async () => {
    appStore.activeSpace = 'home';
    appStore.config = { ...appStore.config, ui: { ...appStore.config.ui, roleplay_enabled: false, bots_enabled: false } };
    vi.spyOn(appStore, 'setActiveSpace').mockImplementation(() => {});
    const onNavigate = vi.fn();
    const view = render(SpaceSwitcher, { onNavigate });
    await fireEvent.click(view.getByRole('tab', { name: 'Code' }));
    expect(appStore.setActiveSpace).toHaveBeenCalledWith('code');
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('sizes the row from the chrome tokens instead of its own pixels', () => {
    const modules = import.meta.glob<string>('./SpaceSwitcher.svelte', { query: '?raw', import: 'default', eager: true });
    const row = modules['./SpaceSwitcher.svelte'];
    // The geometry lives in app.css (--space-btn / --space-icon). A second copy
    // here is how the icon once rendered at the chrome's 14px: a `size-4`
    // utility lost to `.ui-icon-button svg` on specificity.
    expect(row).toContain('var(--space-btn)');
    expect(row).toContain('var(--space-icon)');
    const markup = row.slice(0, row.indexOf('<style>'));
    const style = row.slice(row.indexOf('<style>'));
    expect(markup).not.toContain('size-4');
    // `(?:^|[\s;{])` so a hardcoded size is caught but `stroke-width:` is not.
    expect(style).not.toMatch(/(?:^|[\s;{])(?:width|height):\s*[\d.]/m);

    /*
     * The head is a window drag region (it sits level with the title bar), so
     * the track has to opt out or a press on a glyph drags the window instead
     * of switching the space — the bug that made every tab look dead in the
     * packaged app while a browser tab, which has no drag regions, worked.
     */
    expect(style).toMatch(/\.space-group\s*\{[^}]*app-region:\s*no-drag/s);

    // The rail's rows are `--float-row-radius`; a pill track floated above the
    // list it heads. Both the track and the raised tab come from that one.
    expect(style).toContain('border-radius: var(--float-row-radius)');
    expect(style).toContain('border-radius: calc(var(--float-row-radius) - 2px)');

    // No rail beside the sidebar any more: the floating preview starts at the
    // sheet's own gap.
    const shell = import.meta.glob<string>('./AppShell.svelte', { query: '?raw', import: 'default', eager: true });
    expect(shell['./AppShell.svelte']).not.toContain('ActivityRail');
    expect(shell['./AppShell.svelte']).toContain('left: var(--sheet-gap)');
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

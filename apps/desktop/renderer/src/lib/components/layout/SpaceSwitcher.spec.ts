// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appStore } from '$lib/stores/app.svelte';
import SpaceSwitcher from './SpaceSwitcher.svelte';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  appStore.settingsScreenOpen = false;
});

describe('space switcher', () => {
  it('offers icon tabs with accessible names and horizontal roving focus', async () => {
    appStore.activeSpace = 'home';
    appStore.settingsScreenOpen = false;
    appStore.config = { ...appStore.config, ui: { ...appStore.config.ui, roleplay_enabled: true } };
    vi.spyOn(appStore, 'setActiveSpace').mockImplementation((space) => {
      appStore.activeSpace = space;
    });
    vi.spyOn(appStore, 'persist').mockImplementation(() => {});

    const view = render(SpaceSwitcher);
    expect(view.container.querySelector('[data-space-switcher]')).toBeTruthy();

    // Bots no longer appears in the product navigation. Only the space you are
    // in is named; the rest keep their glyph and are named on hover.
    const tabs = view.getAllByRole('tab');
    const nameOf = (tab: HTMLElement) => tab.getAttribute('aria-label') ?? tab.textContent?.trim();
    expect(tabs.map(nameOf)).toEqual(['Home', 'Code', 'Design', 'Roleplay']);
    expect(tabs[0].textContent?.trim()).toBe('Home');
    expect(tabs.slice(1).every((tab) => !tab.textContent?.trim())).toBe(true);
    const [home, code, design, roleplay] = tabs;
    home.focus();
    await fireEvent.keyDown(home, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(code);
    expect(code.getAttribute('aria-selected')).toBe('true');
    await fireEvent.keyDown(code, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(design);
    await fireEvent.keyDown(design, { key: 'End' });
    expect(document.activeElement).toBe(roleplay);
    await fireEvent.keyDown(roleplay, { key: 'Home' });
    expect(appStore.activeTab).toBe('home');

    // Settings is the sidebar footer's row, not one of these tabs.
    expect(view.queryByRole('button', { name: 'Settings' })).toBeNull();

    expect(view.container.querySelectorAll('.tooltip-anchor')).toHaveLength(4);
    // The named segment explains itself; the glyph-only ones need the pill.
    expect(view.getByRole('tab', { name: 'Code' }).closest('.tooltip-anchor')).toBeTruthy();
    expect(view.getByRole('tablist').getAttribute('aria-orientation')).not.toBe('vertical');
  });

  it('leaves out Roleplay when Settings switches it off', () => {
    appStore.activeSpace = 'home';
    appStore.config = { ...appStore.config, ui: { ...appStore.config.ui, roleplay_enabled: false } };
    const view = render(SpaceSwitcher);
    const labels = () => view.getAllByRole('tab').map((tab) => tab.getAttribute('aria-label') ?? tab.textContent?.trim());
    expect(labels()).toEqual(['Home', 'Code', 'Design']);
  });

  it('ships without Roleplay: a config that never mentioned it is three tabs', () => {
    appStore.activeSpace = 'home';
    const { roleplay_enabled, ...ui } = appStore.config.ui ?? {};
    appStore.config = { ...appStore.config, ui };
    const view = render(SpaceSwitcher);
    expect(view.getAllByRole('tab').map((tab) => tab.getAttribute('aria-label') ?? tab.textContent?.trim())).toEqual(['Home', 'Code', 'Design']);
  });

  it('names a glyph-only space on hover, and never the one in effect', async () => {
    appStore.activeSpace = 'home';
    appStore.config = { ...appStore.config, ui: { ...appStore.config.ui, roleplay_enabled: false } };
    const view = render(SpaceSwitcher);

    const anchor = (name: string) => view.getByRole('tab', { name }).closest('.tooltip-anchor')!;
    await fireEvent.mouseEnter(anchor('Code'));
    await vi.waitFor(() => expect(view.getByRole('tooltip').textContent?.trim()).toBe('Code'));

    // The selected segment already says its name; a pill repeating it is noise.
    await fireEvent.mouseLeave(anchor('Code'));
    await fireEvent.mouseEnter(anchor('Home'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(view.queryByRole('tooltip')).toBeNull();
  });

  it('switches spaces when a tab is chosen', async () => {
    appStore.activeSpace = 'home';
    appStore.config = { ...appStore.config, ui: { ...appStore.config.ui, roleplay_enabled: false } };
    vi.spyOn(appStore, 'setActiveSpace').mockImplementation(() => {});
    const view = render(SpaceSwitcher);
    await fireEvent.click(view.getByRole('tab', { name: 'Code' }));
    expect(appStore.setActiveSpace).toHaveBeenCalledWith('code');
  });

  it('uses the shared segmented control and keeps navigation out of the drag region', () => {
    const modules = import.meta.glob<string>('./SpaceSwitcher.svelte', { query: '?raw', import: 'default', eager: true });
    const row = modules['./SpaceSwitcher.svelte'];
    // Names are on screen now, so the tooltips went: a glyph-only rail hid them.
    expect(row).toContain('<SegmentedControl');
    expect(row).not.toContain('<Tooltip');
    const style = row.slice(row.indexOf('<style>'));

    /*
     * The head is a window drag region (it sits level with the title bar), so
     * the track has to opt out or a press on a glyph drags the window instead
     * of switching the space — the bug that made every tab look dead in the
     * packaged app while a browser tab, which has no drag regions, worked.
     */
    expect(style).toMatch(/\.space-group\s*\{[^}]*app-region:\s*no-drag/s);

    // The switcher belongs to the titlebar, not the sidebar.
    const shell = import.meta.glob<string>('./AppShell.svelte', { query: '?raw', import: 'default', eager: true });
    expect(shell['./AppShell.svelte']).not.toContain('ActivityRail');
    expect(shell['./AppShell.svelte']).toContain('left: var(--sheet-gap)');
    const titlebar = import.meta.glob<string>('./Titlebar.svelte', { query: '?raw', import: 'default', eager: true });
    expect(titlebar['./Titlebar.svelte']).toContain('<SpaceSwitcher />');
    const sidebar = import.meta.glob<string>('./Sidebar.svelte', { query: '?raw', import: 'default', eager: true });
    expect(sidebar['./Sidebar.svelte']).not.toContain('<SpaceSwitcher');
  });

  it('keeps downloads, theme and the window controls in the titlebar', async () => {
    const modules = import.meta.glob<string>('./Titlebar.svelte', { query: '?raw', import: 'default', eager: true });
    const titlebar = modules['./Titlebar.svelte'];
    expect(titlebar).toContain('<DownloadsButton />');
    expect(titlebar).toContain("{$t('titlebar.theme')}");
    // The caption is drawn in the page on Windows and Linux, so the bar
    // reserves nothing for the platform: no overlay rect to measure.
    expect(titlebar).toContain('<WindowControls />');
    expect(titlebar).not.toContain('getTitlebarAreaRect');
    expect(titlebar).not.toContain('geometrychange');
    expect(titlebar).not.toContain('--caption-reserve');
    expect(titlebar).not.toContain('titlebar-area-width');
  });
});

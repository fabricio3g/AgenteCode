import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  legacyFlagToModelHubSection,
  resolveModelHubRoute,
  resolveModelHubSection
} from '../../renderer/src/lib/utils/model-hub-routing.ts';

describe('manager routing', () => {
  it('defaults to the models section', () => {
    assert.equal(resolveModelHubSection(), 'models');
    assert.equal(resolveModelHubSection(null), 'models');
    assert.equal(resolveModelHubSection('unknown'), 'models');
  });

  it('maps the legacy Explore route to Models → Discover', () => {
    assert.deepEqual(resolveModelHubRoute('explore'), { section: 'models', modelTab: 'discover' });
  });

  it('routes legacy modal flags into manager sections', () => {
    assert.equal(legacyFlagToModelHubSection('settingsOpen'), 'general');
    assert.equal(legacyFlagToModelHubSection('runtimeManagerOpen'), 'local');
  });

  it('preserves supported deep links and maps legacy settings aliases', () => {
    assert.equal(resolveModelHubSection('models'), 'models');
    assert.equal(resolveModelHubSection('explore'), 'explore');
    assert.equal(resolveModelHubSection('general'), 'general');
    assert.equal(resolveModelHubSection('search'), 'search');
    assert.equal(resolveModelHubSection('hardware'), 'local');
    assert.equal(resolveModelHubSection('providers'), 'providers');
    assert.equal(resolveModelHubSection('runtime'), 'local');
    assert.equal(resolveModelHubSection('api'), 'providers');
    assert.equal(resolveModelHubSection('settings'), 'general');
    assert.equal(resolveModelHubSection('voices'), 'voice');
    assert.equal(resolveModelHubSection('whisper'), 'voice');
  });
});

describe('models and settings shell integration', () => {
  // Models, providers and preferences are all sections of the Settings screen,
  // so the sidebar has one door to that room, not two — and no Runtime either.
  it('leaves one sidebar entry for Settings and no separate Models or Runtime entry', () => {
    const sidebar = readFileSync('renderer/src/lib/components/layout/Sidebar.svelte', 'utf8');
    // Labels are translated: match the message keys the buttons render.
    assert.equal((sidebar.match(/<span class="sidebar-row-label">\{\$t\('sidebar\.settings'\)\}<\/span>/g) || []).length, 1);
    assert.equal((sidebar.match(/sidebar\.models|>Models</g) || []).length, 0);
    assert.equal((sidebar.match(/sidebar\.runtime|>Runtime</g) || []).length, 0);
  });

  it('does not render legacy SettingsModal or LocalRuntimeModal from AppShell', () => {
    const appShell = readFileSync('renderer/src/lib/components/layout/AppShell.svelte', 'utf8');
    assert.match(appShell, /legacyFlagToModelHubSection\('settingsOpen'\)/);
    assert.match(appShell, /legacyFlagToModelHubSection\('runtimeManagerOpen'\)/);
    assert.doesNotMatch(appShell, /<SettingsModal/);
    assert.doesNotMatch(appShell, /<LocalRuntimeModal/);
  });

  // Settings is a screen in the shell, not a modal over it: the surface
  // underneath has to stay mounted, which only holds if the screen is layered
  // on top of the workspace instead of joining the space branch.
  it('mounts Settings over the workspace, never in the space branch', () => {
    const appShell = readFileSync('renderer/src/lib/components/layout/AppShell.svelte', 'utf8');
    assert.match(appShell, /<SettingsScreen \/>/);
    assert.doesNotMatch(appShell, /<ModelHubModal/);
    const host = appShell.indexOf('</WorkspaceHost>');
    const screen = appShell.indexOf('<SettingsScreen');
    assert.ok(host > 0 && screen > host, 'the screen is layered above the workspace, not inside it');
  });

  it('opens Settings from the sidebar through the screen, not the old modal flags', () => {
    const sidebar = readFileSync('renderer/src/lib/components/layout/Sidebar.svelte', 'utf8');
    assert.equal((sidebar.match(/appStore\.openSettings\('/g) || []).length, 1);
    assert.doesNotMatch(sidebar, /modelManagerOpen/);
    // The screen's way back: focus returns to the button that opened it.
    assert.match(sidebar, /data-sidebar-settings/);
  });
});

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
  it('renders separate expanded sidebar Models and Settings entries and no separate Runtime entry', () => {
    const sidebar = readFileSync('renderer/src/lib/components/layout/Sidebar.svelte', 'utf8');
    assert.equal((sidebar.match(/<span class="btn-label">Models<\/span>/g) || []).length, 1);
    assert.equal((sidebar.match(/<span class="btn-label">Settings<\/span>/g) || []).length, 1);
    assert.equal((sidebar.match(/<span class="btn-label">Runtime<\/span>/g) || []).length, 0);
  });

  it('does not render legacy SettingsModal or LocalRuntimeModal from AppShell', () => {
    const appShell = readFileSync('renderer/src/lib/components/layout/AppShell.svelte', 'utf8');
    assert.match(appShell, /legacyFlagToModelHubSection\('settingsOpen'\)/);
    assert.match(appShell, /legacyFlagToModelHubSection\('runtimeManagerOpen'\)/);
    assert.doesNotMatch(appShell, /<SettingsModal/);
    assert.doesNotMatch(appShell, /<LocalRuntimeModal/);
  });
});

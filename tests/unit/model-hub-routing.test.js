import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  legacyFlagToModelHubSection,
  resolveModelHubSection
} from '../../renderer/src/lib/utils/model-hub-routing.ts';

describe('model hub routing', () => {
  it('defaults to the models section', () => {
    assert.equal(resolveModelHubSection(), 'models');
    assert.equal(resolveModelHubSection(null), 'models');
    assert.equal(resolveModelHubSection('unknown'), 'models');
  });

  it('routes legacy modal flags into Model Hub sections', () => {
    assert.equal(legacyFlagToModelHubSection('settingsOpen'), 'settings');
    assert.equal(legacyFlagToModelHubSection('runtimeManagerOpen'), 'runtime');
  });

  it('preserves supported deep links and maps old search links to settings', () => {
    assert.equal(resolveModelHubSection('models'), 'models');
    assert.equal(resolveModelHubSection('explore'), 'explore');
    assert.equal(resolveModelHubSection('providers'), 'providers');
    assert.equal(resolveModelHubSection('runtime'), 'runtime');
    assert.equal(resolveModelHubSection('settings'), 'settings');
    assert.equal(resolveModelHubSection('voices'), 'voices');
    assert.equal(resolveModelHubSection('whisper'), 'whisper');
    assert.equal(resolveModelHubSection('search'), 'settings');
  });
});

describe('model hub shell integration', () => {
  it('renders one expanded sidebar Model Hub entry and no separate Runtime or Settings entries', () => {
    const sidebar = readFileSync('renderer/src/lib/components/layout/Sidebar.svelte', 'utf8');
    assert.equal((sidebar.match(/<span class="btn-label">Model Hub<\/span>/g) || []).length, 1);
    assert.equal((sidebar.match(/<span class="btn-label">Runtime<\/span>/g) || []).length, 0);
    assert.equal((sidebar.match(/<span class="btn-label">Settings<\/span>/g) || []).length, 0);
  });

  it('does not render legacy SettingsModal or LocalRuntimeModal from AppShell', () => {
    const appShell = readFileSync('renderer/src/lib/components/layout/AppShell.svelte', 'utf8');
    assert.match(appShell, /legacyFlagToModelHubSection\('settingsOpen'\)/);
    assert.match(appShell, /legacyFlagToModelHubSection\('runtimeManagerOpen'\)/);
    assert.doesNotMatch(appShell, /<SettingsModal/);
    assert.doesNotMatch(appShell, /<LocalRuntimeModal/);
  });
});

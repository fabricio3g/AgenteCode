import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { mergeUiSettingsConfig } from '../../renderer/src/lib/stores/app-store-config.ts';

describe('roleplay shell mode config', () => {
  it('persists roleplay shell mode without dropping existing UI settings', () => {
    const next = mergeUiSettingsConfig(
      { ui: { workspace_mode: 'modern', show_assistant_text: false, enable_thinking: true } },
      { shell_mode: 'roleplay' }
    );

    assert.equal(next.ui?.shell_mode, 'roleplay');
    assert.equal(next.ui?.workspace_mode, 'modern');
    assert.equal(next.ui?.show_assistant_text, false);
    assert.equal(next.ui?.enable_thinking, true);
  });

  it('can switch back to standard shell mode', () => {
    const next = mergeUiSettingsConfig(
      { ui: { shell_mode: 'roleplay' } },
      { shell_mode: 'standard' }
    );

    assert.equal(next.ui?.shell_mode, 'standard');
  });
});

describe('roleplay shell mode UI wiring', () => {
  it('routes roleplay mode to roleplay workspace and keeps roleplay toggle controls', () => {
    const appShell = readFileSync('renderer/src/lib/components/layout/AppShell.svelte', 'utf8');
    const sidebar = readFileSync('renderer/src/lib/components/layout/Sidebar.svelte', 'utf8');
    const roleplayWorkspace = readFileSync('renderer/src/lib/components/roleplay/RoleplayWorkspace.svelte', 'utf8');

    assert.match(appShell, /appStore\.shellMode === 'roleplay'\}[\s\S]*<RoleplayWorkspace \/>/);
    assert.match(appShell, /appStore\.toggleRoleplayMode\(\)/);
    assert.match(sidebar, /Roleplay/);
    assert.match(sidebar, /appStore\.toggleRoleplayMode\(\)/);
    assert.match(roleplayWorkspace, /class:expanded=\{appStore\.sidebarOpen\}/);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../../renderer/src/lib/components/settings/SearchSettings.svelte', import.meta.url), 'utf8');
const panel = fs.readFileSync(new URL('../../renderer/src/lib/components/settings/UnifiedSettingsPanel.svelte', import.meta.url), 'utf8');
const preload = fs.readFileSync(new URL('../../preload/preload.cjs', import.meta.url), 'utf8');

describe('aggregator engine settings UI', () => {
  it('shows the engine pool only for the aggregator provider', () => {
    assert.match(source, /\{#if searchProvider === 'aggregator'\}/);
    assert.match(source, />Engine pool</);
  });

  it('provides individual and bulk engine controls', () => {
    assert.match(source, /toggleEngine\(item\)/);
    assert.match(source, />Enable recommended</);
    assert.match(source, />Enable all configured</);
    assert.match(source, />Disable all</);
    assert.match(source, />Reset(?: to recommended)?</);
  });

  it('binds and persists the enabled engine list', () => {
    assert.match(source, /aggregatorEngines = \$bindable\(\)/);
    assert.match(panel, /aggregator_engines: aggregatorEngines/);
    assert.match(panel, /aggregatorEngines\.length === 0/);
  });

  it('does not silently enable an engine when its configuration changes', () => {
    const updateConfigBody = source.match(/function updateConfig[\s\S]*?\n  \}/)?.[0] || '';
    assert.doesNotMatch(updateConfigBody, /aggregatorEngines\s*=/);
  });

  it('exposes the catalog and probe channels to the renderer', () => {
    assert.match(preload, /'search:get-catalog'/);
    assert.match(preload, /'search:probe-engines'/);
  });
});

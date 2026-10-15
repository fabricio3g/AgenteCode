import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { versionLabel } from './app-meta';

const root = path.resolve(__dirname, '../../../../..');

describe('versionLabel', () => {
  it('reads like the TUI: the release, then the commit', () => {
    expect(versionLabel('0.2.3', 'a1b2c3d')).toBe('v0.2.3 · a1b2c3d');
    expect(versionLabel('0.2.3', '')).toBe('v0.2.3');
    expect(versionLabel('', 'a1b2c3d')).toBe('');
  });

  it('ships the same release as the Cargo workspace (TUI, CLI, Android)', () => {
    const cargo = readFileSync(path.join(root, 'Cargo.toml'), 'utf8');
    const workspace = /\[workspace\.package\][^[]*?^version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1];
    const desktop = JSON.parse(readFileSync(path.join(root, 'apps/desktop/package.json'), 'utf8')).version;
    expect(workspace).toBeTruthy();
    expect(desktop).toBe(workspace);
  });
});

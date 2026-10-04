import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { WindowThemePreferences } from '../../main/window-theme-preferences.ts';
import { WINDOW_THEME_COLORS, windowThemeBootstrap, windowThemeCss } from '../../shared/window-theme.ts';

it('restores startup colors before application modules, even without localStorage', () => {
  for (const preference of ['light', 'dark', 'invalid', null, 'unavailable']) {
    let dark, overlay;
    runInNewContext(windowThemeBootstrap(), {
      localStorage: { getItem: () => { if (preference === 'unavailable') throw new Error('denied'); return preference; } },
      document: { documentElement: { classList: { toggle: (_name, value) => { dark = value; } } } },
      window: { electronAPI: { windowSetTitlebarOverlay: value => { overlay = value; } } }
    });
    const expected = preference === 'light' ? 'light' : 'dark';
    assert.equal(dark, expected === 'dark');
    assert.equal(overlay.color, WINDOW_THEME_COLORS[expected].color);
    assert.ok(windowThemeCss().includes(overlay.color));
  }
});
it('persists the final rapid theme change and recovers from invalid native preferences', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agente-theme-test-'));
  try {
    const file = join(root, 'window-theme.json');
    await writeFile(file, '{broken');
    const prefs = new WindowThemePreferences(file);
    assert.equal(prefs.theme, 'dark');
    prefs.update('light'); prefs.update('dark'); prefs.update('light');
    await prefs.flush();
    assert.equal(JSON.parse(await readFile(file, 'utf8')).theme, 'light');
    assert.equal(new WindowThemePreferences(file).theme, 'light');
    prefs.update('dark'); await prefs.flush();
    assert.equal(new WindowThemePreferences(file).theme, 'dark');
  } finally { await rm(root, { recursive: true, force: true }); }
});

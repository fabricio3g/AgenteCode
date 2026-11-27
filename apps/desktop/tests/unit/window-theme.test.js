import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { WindowThemePreferences } from '../../main/window-theme-preferences.ts';
import { THEME_STORAGE_KEY, WINDOW_THEME_COLORS, windowThemeBootstrap, windowThemeCss } from '../../shared/window-theme.ts';
import { APPEARANCE_STORAGE_KEY } from '../../shared/appearance.ts';

it('restores startup colors before application modules, even without localStorage', () => {
  // The legacy one-word preference, with no Appearance settings saved yet.
  for (const preference of ['light', 'dark', 'invalid', null, 'unavailable']) {
    const { dark, overlay, dataset } = boot((key) => {
      if (preference === 'unavailable') throw new Error('denied');
      return key === THEME_STORAGE_KEY ? preference : null;
    });
    const expected = preference === 'light' ? 'light' : 'dark';
    assert.equal(dark, expected === 'dark');
    assert.equal(overlay.color, WINDOW_THEME_COLORS[expected].color);
    assert.ok(windowThemeCss().includes(overlay.color));
    assert.equal(dataset.theme, 'agente');
  }
});
it('restores the Appearance settings (mode, theme, styles) before the first paint', () => {
  const saved = JSON.stringify({ mode: 'light', theme: 'sepia', uiStyle: 'soft', composerStyle: 'pill', accent: 'ocean' });
  const { dark, dataset, overlay } = boot((key) => (key === APPEARANCE_STORAGE_KEY ? saved : 'dark'));
  assert.equal(dark, false, 'Appearance wins over the legacy key');
  assert.deepEqual({ ...dataset }, { theme: 'sepia', uiStyle: 'soft', composerStyle: 'pill', accent: 'ocean' });
  assert.ok(overlay.color);
  // Broken JSON falls back to the defaults instead of throwing.
  const fallback = boot((key) => (key === APPEARANCE_STORAGE_KEY ? '{broken' : null));
  assert.equal(fallback.dark, true);
  assert.equal(fallback.dataset.theme, 'agente');
});

/** Run the startup script against a page that has only what it touches. */
function boot(getItem) {
  let dark;
  let overlay;
  const dataset = {};
  runInNewContext(windowThemeBootstrap(), {
    localStorage: { getItem },
    document: { documentElement: { dataset, classList: { toggle: (_name, value) => { dark = value; } } } },
    window: { electronAPI: { windowSetTitlebarOverlay: (value) => { overlay = value; } } },
    Promise
  });
  return { dark, overlay, dataset };
}
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

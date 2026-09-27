/**
 * Imported first by index.ts: moves an old "Flaxeo Chat" or "Chatea" data
 * folder into "Agente" before any module reads a path, then brings the old
 * browser profile along.
 */
import { app } from 'electron';
import { dataRoot, keyringAppName, migrateBrowserProfile, migrateDataFolder } from './data-folder.ts';

const moves = [
  ...migrateDataFolder(app.getPath('appData'), app.getPath('home')),
  ...migrateBrowserProfile(app.getPath('appData'), app.getPath('userData'))
];
if (moves.length) console.log(`[data-folder] ${moves.length} move(s):\n  ${moves.join('\n  ')}`);

// Keep the keyring entry that encrypts saved API keys (see keyringAppName).
// The name must be set before the app is ready; userData is pinned first so
// the folder stays the one the current name gives.
const keyringName = keyringAppName(dataRoot(app.getPath('appData')), app.isPackaged ? 'Flaxeo Chat' : 'chatealm');
if (keyringName && keyringName !== app.getName()) {
  const userData = app.getPath('userData');
  app.setName(keyringName);
  app.setPath('userData', userData);
}

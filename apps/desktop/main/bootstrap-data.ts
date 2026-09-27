/**
 * Imported first by index.ts: moves an old "Flaxeo Chat" or "Chatea" data
 * folder into "Agente" before any module reads a path, then brings the old
 * browser profile along.
 */
import { app } from 'electron';
import { migrateBrowserProfile, migrateDataFolder } from './data-folder.ts';

const moves = [
  ...migrateDataFolder(app.getPath('appData'), app.getPath('home')),
  ...migrateBrowserProfile(app.getPath('appData'), app.getPath('userData'))
];
if (moves.length) console.log(`[data-folder] ${moves.length} move(s):\n  ${moves.join('\n  ')}`);

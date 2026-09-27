/**
 * Imported first by index.ts: moves an old "Chatea" data folder into
 * "Flaxeo Chat" before any module reads a path.
 */
import { app } from 'electron';
import { migrateDataFolder } from './data-folder.ts';

const moves = migrateDataFolder(app.getPath('appData'), app.getPath('home'));
if (moves.length) console.log(`[data-folder] ${moves.length} move(s):\n  ${moves.join('\n  ')}`);

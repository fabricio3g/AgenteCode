/**
 * Where Agente keeps its data, and the one-time move from the old
 * "Flaxeo Chat" and "Chatea" folders into it.
 *
 *   Agente/
 *     engines/llama.cpp/<build>/     engines/whisper.cpp/<build>/
 *     models/chat/   models/speech/   models/voices/
 *     downloads/     cache/           config.json, downloads.json
 *
 * The move runs at startup before anything reads a path: the old folder is
 * renamed into place (same disk, instant), the old layout inside it is
 * reorganized, and every stored absolute path is rewritten. Each step is
 * idempotent and failures are logged, never fatal — the resolvers still look
 * in the old sub-folders.
 */

import fs from 'node:fs';
import path from 'node:path';

export const DATA_FOLDER_NAME = 'Agente';

/** Env overrides for the data folder, newest name first. */
const HOME_OVERRIDES = ['AGENTE_HOME', 'FLAXEO_HOME', 'TALAMOLM_HOME'];

function homeOverride(): string {
  for (const name of HOME_OVERRIDES) {
    const value = String(process.env[name] || '').trim();
    if (value) return value;
  }
  return '';
}

/** Old layout → new layout, relative to the data folder, most specific first. */
const LAYOUT_MOVES: Array<[string[], string[]]> = [
  [['bin', 'whisper', 'versions'], ['engines', 'whisper.cpp']],
  [['bin', 'whisper'], ['engines', 'whisper.cpp', 'default']],
  [['bin', 'versions'], ['engines', 'llama.cpp']],
  [['bin'], ['engines', 'llama.cpp', 'default']],
  [['models', 'llama-cpp'], ['models', 'chat']]
];

/** Files whose string values may hold absolute paths into the data folder. */
const PATH_FILES = ['config.json', 'downloads.json'];

export function dataRoot(appDataDir: string): string {
  return homeOverride() || path.join(appDataDir, DATA_FOLDER_NAME);
}

function oldRoots(appDataDir: string, homeDir: string): string[] {
  return [
    path.join(appDataDir, 'Flaxeo Chat'),
    path.join(appDataDir, 'Chatea'),
    path.join(appDataDir, 'Chatea LM'),
    path.join(homeDir, '.chatealm')
  ];
}

const exists = (p: string) => { try { fs.accessSync(p); return true; } catch { return false; } };

/** Move `from` to `to`, merging into an existing folder one entry at a time. */
function moveInto(from: string, to: string, log: string[]): void {
  if (!exists(from)) return;
  if (!exists(to)) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    log.push(`${from} → ${to}`);
    return;
  }
  if (!fs.statSync(from).isDirectory() || !fs.statSync(to).isDirectory()) return;
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    const dest = path.join(to, name);
    if (exists(dest)) continue; // never overwrite what is already there
    fs.renameSync(src, dest);
    log.push(`${src} → ${dest}`);
  }
  try { fs.rmdirSync(from); } catch { /* not empty: leave the leftovers */ }
}

/** Map one absolute path from an old root / old layout to the new one. */
export function mapDataPath(value: string, roots: string[], root: string): string {
  let mapped = value;
  for (const old of roots) {
    if (mapped === old || mapped.startsWith(old + path.sep)) {
      mapped = root + mapped.slice(old.length);
      break;
    }
  }
  if (!(mapped === root || mapped.startsWith(root + path.sep))) return value;
  const rel = path.relative(root, mapped).split(path.sep);
  for (const [oldParts, newParts] of LAYOUT_MOVES) {
    if (oldParts.every((part, i) => rel[i] === part)) {
      return path.join(root, ...newParts, ...rel.slice(oldParts.length));
    }
  }
  return mapped;
}

function rewriteStrings(value: unknown, map: (s: string) => string): unknown {
  if (typeof value === 'string') return map(value);
  if (Array.isArray(value)) return value.map((item) => rewriteStrings(item, map));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewriteStrings(v, map)]));
  }
  return value;
}

/**
 * Bring the data folder to the current name and layout. Returns what moved,
 * for the log. Safe to call on every start.
 */
export function migrateDataFolder(appDataDir: string, homeDir: string): string[] {
  const log: string[] = [];
  if (homeOverride()) return log;
  const root = dataRoot(appDataDir);
  const roots = oldRoots(appDataDir, homeDir);

  try {
    // 1. The old folder becomes the new one (or merges into it).
    const hasConfig = exists(path.join(root, 'config.json'));
    const legacy = roots.find((candidate) => exists(path.join(candidate, 'config.json')) || exists(path.join(candidate, 'bin')));
    if (legacy && !hasConfig) moveInto(legacy, root, log);

    // 2. The old layout inside it.
    for (const [oldParts, newParts] of LAYOUT_MOVES) {
      const from = path.join(root, ...oldParts);
      if (!exists(from) || !fs.statSync(from).isDirectory()) continue;
      // An emptied parent (bin/ after its sub-folders moved) just goes away;
      // anything still in it (a hand-placed llama-server) is an engine.
      if (!fs.readdirSync(from).length) { fs.rmdirSync(from); continue; }
      moveInto(from, path.join(root, ...newParts), log);
    }

    // 3. Stored absolute paths.
    if (log.length) {
      for (const file of PATH_FILES) {
        const full = path.join(root, file);
        if (!exists(full)) continue;
        const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
        const next = rewriteStrings(parsed, (s) => (path.isAbsolute(s) ? mapDataPath(s, roots, root) : s));
        const text = JSON.stringify(next, null, 2);
        fs.writeFileSync(`${full}.tmp`, text);
        fs.renameSync(`${full}.tmp`, full);
      }
      fs.writeFileSync(path.join(root, '.migrated.json'), JSON.stringify({ at: new Date().toISOString(), moves: log }, null, 2));
    }
  } catch (err) {
    log.push(`migration stopped: ${err instanceof Error ? err.message : String(err)}`);
  }
  return log;
}

/**
 * The browser profile (local storage, IndexedDB, caches) lives in Electron's
 * userData, which follows the app name. When the name changed, bring the old
 * profile along so settings kept in local storage survive.
 */
export function migrateBrowserProfile(appDataDir: string, userDataDir: string): string[] {
  const log: string[] = [];
  if (exists(path.join(userDataDir, 'Local Storage'))) return log;
  try {
    const legacy = ['chatealm', 'Flaxeo Chat']
      .map((name) => path.join(appDataDir, name))
      .find((dir) => dir !== userDataDir && exists(path.join(dir, 'Local Storage')));
    if (legacy) moveInto(legacy, userDataDir, log);
  } catch (err) {
    log.push(`profile move stopped: ${err instanceof Error ? err.message : String(err)}`);
  }
  return log;
}

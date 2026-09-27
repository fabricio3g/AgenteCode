/**
 * Application paths module.
 * Provides path resolution without depending on the main index module.
 */

import path from 'node:path';
import { moduleRequire, moduleDirname } from './module-env.ts';
import { dataRoot } from './data-folder.ts';

const nodeRequire = moduleRequire;
const moduleDir = moduleDirname(import.meta.url);

/**
 * Gets the app paths. Uses lazy Electron import to avoid circular dependencies.
 */
export function getAppPaths() {
  // Lazy import - Electron is only available inside Electron runtime
  const { app } = nodeRequire('electron');
  
  // Flaxeo Chat/ in the OS app-data folder; data-folder.ts moves old installs here.
  const appData = dataRoot(app.getPath('appData'));

  const isDev = !app.isPackaged;
  const projectRoot = isDev
    ? path.resolve(moduleDir, '..', '..')
    : path.dirname(app.getPath('exe'));

  return {
    appData,
    modelsRoot: isDev
      ? path.join(projectRoot, 'models')
      : path.join(process.resourcesPath, 'models'),
    assetsRoot: isDev
      ? path.join(projectRoot, 'assets')
      : path.join(process.resourcesPath, 'assets'),
    enginesRoot: path.join(appData, 'engines'),
    localModelsRoot: path.join(appData, 'models', 'chat'),
    speechModelsRoot: path.join(appData, 'models', 'speech'),
    voiceModelsRoot: path.join(appData, 'models', 'voices'),
    downloadsRoot: path.join(appData, 'downloads'),
    localBinRoot: path.join(appData, 'engines', 'llama.cpp', 'default'),
    localBinVersionsRoot: path.join(appData, 'engines', 'llama.cpp'),
    whisperBinRoot: path.join(appData, 'engines', 'whisper.cpp', 'default'),
    whisperBinVersionsRoot: path.join(appData, 'engines', 'whisper.cpp'),
    nativeBinRoot: isDev
      ? path.join(projectRoot, 'resources', 'bin')
      : path.join(process.resourcesPath, 'bin'),
    cacheRoot: path.join(appData, 'cache'),
    configPath: path.join(appData, 'config.json'),
    secretsPath: path.join(appData, 'secrets.json'),
    projectRoot,
    IS_DEV: isDev
  };
}

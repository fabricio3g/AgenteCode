/**
 * Application paths module.
 * Provides path resolution without depending on the main index module.
 */

import fs from 'node:fs';
import path from 'node:path';

const APP_NAME = 'Chatea LM';

// Handle both ESM (tsx dev) and CJS (esbuild bundled) environments
// esbuild CJS bundle provides __dirname global, ESM uses import.meta.url

// Get __dirname - works in both CJS bundle and ESM with tsx
const __dirname: string = (() => {
  // In CJS bundled by esbuild, __dirname is a global
  // We use eval to safely access it without TypeScript complaining
  try {
    const cjsDirname = eval('typeof __dirname === "string" ? __dirname : null');
    if (cjsDirname) return cjsDirname;
  } catch {}
  
  // In ESM with tsx, derive from import.meta.url
  try {
    const metaUrl = (import.meta as any)?.url;
    if (typeof metaUrl === 'string' && metaUrl) {
      const { fileURLToPath } = require('node:url');
      return path.dirname(fileURLToPath(metaUrl));
    }
  } catch {}
  
  // Fallback
  return process.cwd();
})();

/**
 * Gets the app paths. Uses lazy Electron import to avoid circular dependencies.
 */
export function getAppPaths() {
  // Lazy import - Electron is only available inside Electron runtime
  const { app } = require('electron');
  
  const envOverride = String(process.env.TALAMOLM_HOME || '').trim();
  const legacyAppData = path.join(app.getPath('home'), '.chatealm');
  const platformAppData = path.join(app.getPath('appData'), APP_NAME);
  const appData = envOverride || (fs.existsSync(legacyAppData) ? legacyAppData : platformAppData);
  
  const isDev = !app.isPackaged;
  const projectRoot = isDev
    ? path.resolve(__dirname, '..', '..')
    : path.dirname(app.getPath('exe'));

  return {
    appData,
    modelsRoot: isDev
      ? path.join(projectRoot, 'models')
      : path.join(process.resourcesPath, 'models'),
    assetsRoot: isDev
      ? path.join(projectRoot, 'assets')
      : path.join(process.resourcesPath, 'assets'),
    localModelsRoot: path.join(appData, 'models', 'llama-cpp'),
    localBinRoot: path.join(appData, 'bin'),
    localBinVersionsRoot: path.join(appData, 'bin', 'versions'),
    cacheRoot: path.join(appData, 'cache'),
    configPath: path.join(appData, 'config.json'),
    secretsPath: path.join(appData, 'secrets.json'),
    projectRoot,
    IS_DEV: isDev
  };
}
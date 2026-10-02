// Check the archive after Builder transforms metadata and before installers.
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');
module.exports = async function verifyPackage(context) {
  const root = context.packager.projectDir;
  const resources = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app/Contents/Resources`)
    : path.join(context.appOutDir, 'resources');
  const archive = path.join(resources, 'app.asar');
  if (fs.existsSync(path.join(resources, 'bin/llama/rocm'))) throw new Error('ROCm must be downloaded through the UI, not bundled');
  for (const file of ['dist-electron/main/index.cjs', 'preload/preload.cjs', 'renderer/dist/index.html']) {
    if (!asar.extractFile(archive, path.normalize(file)).equals(fs.readFileSync(path.join(root, file)))) throw new Error(`Corrupt packaged asset: ${file}`);
  }
  const metadata = JSON.parse(asar.extractFile(archive, 'package.json').toString());
  if (metadata.name !== 'agente-desktop' || metadata.main !== 'dist-electron/main/index.cjs') throw new Error('Packaged application identity changed');
};

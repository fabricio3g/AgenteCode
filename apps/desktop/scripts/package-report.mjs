import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const asar = require('@electron/asar');

export function directoryBytes(dir) {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => {
    const file = path.join(dir, entry.name);
    return sum + (entry.isDirectory() ? directoryBytes(file) : entry.isSymbolicLink() ? 0 : fs.statSync(file).size);
  }, 0);
}
export function packageReport(unpacked, release) {
  const resources = path.join(unpacked, 'resources');
  const archive = path.join(resources, 'app.asar');
  const totals = { renderer: 0, dependencies: 0, rust: 0, backends: {}, installed: directoryBytes(unpacked), installers: {} };
  for (const file of asar.listPackage(archive)) {
    const relative = file.replace(/^[\\/]+/, '').replace(/\\/g, '/');
    const stat = asar.statFile(archive, relative);
    if (stat.files || stat.link) continue;
    if (relative.startsWith('renderer/dist/')) totals.renderer += stat.size;
    if (relative.startsWith('node_modules/')) totals.dependencies += stat.size;
  }
  const bin = path.join(resources, 'bin');
  totals.rust = fs.statSync(path.join(bin, process.platform === 'win32' ? 'agente.exe' : 'agente')).size;
  for (const engine of fs.readdirSync(bin, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const dir = path.join(bin, engine.name);
    for (const backend of fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory())) totals.backends[`${engine.name}/${backend.name}`] = directoryBytes(path.join(dir, backend.name));
  }
  for (const file of fs.readdirSync(release).filter((name) => /^AgenteDesktop-.*\.(exe|deb|AppImage|zip)$/.test(name))) totals.installers[file] = fs.statSync(path.join(release, file)).size;
  return totals;
}
if (process.argv[1] === new URL(import.meta.url).pathname || process.argv[1]?.endsWith('package-report.mjs')) {
  const unpacked = path.resolve(process.argv[2] || `release/${process.platform === 'win32' ? 'win' : 'linux'}-unpacked`);
  const release = path.dirname(unpacked);
  const report = packageReport(unpacked, release);
  const output = path.join(release, `AgenteDesktop-size-${process.platform}.json`);
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}

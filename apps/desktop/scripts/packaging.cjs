// Packaging checks and removal of dependencies already included by esbuild.
const fs = require('node:fs');
const path = require('node:path');

function packageName(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) return null;
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
}
function resolvePackage(root, name) {
  for (let dir = root; ; dir = path.dirname(dir)) {
    const file = path.join(dir, 'node_modules', name, 'package.json');
    if (fs.existsSync(file)) return file;
    if (path.dirname(dir) === dir) return null;
  }
}
function bundledDuplicates(root, manifest, meta) {
  const protectedNames = new Set();
  const seen = new Set();
  const visit = (name, from) => {
    protectedNames.add(name);
    const file = resolvePackage(from, name);
    if (!file || seen.has(file)) return;
    seen.add(file);
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const dependency of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })) visit(dependency, path.dirname(file));
  };
  const external = Object.values(meta.outputs).flatMap((output) => output.imports.filter((entry) => entry.external).map((entry) => packageName(entry.path))).filter(Boolean);
  // Optional runtimes and their dependencies stay intact, even if loaded dynamically.
  for (const name of [...external, ...Object.keys(manifest.optionalDependencies || {})]) visit(name, root);
  return Object.keys(manifest.dependencies).filter((name) => !protectedNames.has(name) && Object.keys(meta.inputs).some((file) => file.startsWith(`node_modules/${name}/`)));
}
function validateRenderer(root) {
  const html = fs.readFileSync(path.join(root, 'renderer/dist/index.html'), 'utf8');
  if (/\b(?:src|href)=["']\/(?!\/)/.test(html)) throw new Error('Packaged renderer contains root-relative asset URLs');
  if (fs.readdirSync(path.join(root, 'renderer/dist/assets')).some((file) => file.endsWith('.map'))) throw new Error('Production renderer must not ship source maps');
  for (const file of ['preload/preload.cjs', 'dist-electron/main/index.cjs', 'renderer/dist/app-icon.png']) if (!fs.statSync(path.join(root, file)).size) throw new Error(`Missing packaging asset: ${file}`);
}
async function beforePack(context) {
  const root = context.packager.projectDir;
  validateRenderer(root);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(root, 'dist-electron/main/meta.json'), 'utf8'));
  const duplicates = bundledDuplicates(root, manifest, meta);
  const licenses = path.join(root, 'dist-electron/main/licenses');
  fs.rmSync(licenses, { recursive: true, force: true });
  for (const name of duplicates) {
    const directory = path.dirname(resolvePackage(root, name));
    const destination = path.join(licenses, name.replace('/', '__'));
    fs.mkdirSync(destination, { recursive: true });
    const dependency = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    fs.writeFileSync(path.join(destination, 'package.json'), JSON.stringify({ name, version: dependency.version, license: dependency.license }, null, 2));
    for (const file of fs.readdirSync(directory).filter((file) => /^(license|copying|notice)/i.test(file))) fs.cpSync(path.join(directory, file), path.join(destination, file), { recursive: true });
  }
  if (process.env.AGENTE_RELEASE_BUILD === '1' && ['linux', 'win32'].includes(context.electronPlatformName)) {
    const exe = context.electronPlatformName === 'win32' ? '.exe' : '';
    for (const backend of ['cpu', 'vulkan', 'cuda', 'sycl']) {
      if (!fs.existsSync(path.join(root, 'resources/bin/llama', backend, `llama-server${exe}`))) throw new Error(`Missing release backend: llama/${backend}`);
    }
    for (const [engine, binary] of [['audio', 'audiocpp_server'], ['whisper', 'whisper-cli']]) {
      if (!fs.existsSync(path.join(root, 'resources/bin', engine, 'cpu', `${binary}${exe}`))) throw new Error(`Missing release engine: ${engine}/cpu`);
    }
  }
  const exclusions = duplicates.map((name) => `!node_modules/${name}{,/**/*}`);
  // Builder normalizes files into FileSet objects before this hook. Adding
  // strings beside those objects creates a second app file set and duplicate
  // ASAR entries, corrupting file offsets. Extend the existing filters instead.
  const files = context.packager.config.files;
  if (files.every((entry) => typeof entry === 'string')) files.push(...exclusions);
  else for (const entry of files) {
    if (typeof entry !== 'string') entry.filter = [...(Array.isArray(entry.filter) ? entry.filter : entry.filter ? [entry.filter] : []), ...exclusions];
  }
  console.log(`[package] Already bundled dependencies excluded: ${duplicates.join(', ') || 'none'}`);
}
module.exports = beforePack;
module.exports.bundledDuplicates = bundledDuplicates;
module.exports.validateRenderer = validateRenderer;

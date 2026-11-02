import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getAppPaths } from '../paths.ts';
import { extractArchive, ensureSafeEntryPath } from '../archive-install.ts';
import { trackDownload } from '../model-download.ts';

const exec = promisify(execFile);
export const BLENDER_VERSION = '4.5.15';
const RELEASE = 'https://download.blender.org/release/Blender4.5/';
const engineRoot = () => path.join(getAppPaths().enginesRoot, 'blender');
let installing: Promise<string> | undefined;
export const isInstallingBlender = () => !!installing;

export function blenderAsset(platform = process.platform, arch = process.arch): string {
  const target = platform === 'win32' ? `windows-${arch}.zip` : platform === 'darwin' ? `macos-${arch}.dmg` : platform === 'linux' && arch === 'x64' ? 'linux-x64.tar.xz' : '';
  if (!target || !['x64', 'arm64'].includes(arch)) throw new Error(`No bundled Blender download for ${platform}/${arch}. Choose an existing Blender executable.`);
  return `blender-${BLENDER_VERSION}-${target}`;
}

export async function checkBlender(executable: string): Promise<string> {
  const resolved = path.resolve(executable);
  if (!fs.statSync(resolved).isFile()) throw new Error('Choose the Blender executable.');
  const { stdout } = await exec(resolved, ['--version'], { windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 });
  if (!/^Blender (\d+)\.(\d+)/m.test(stdout)) throw new Error('This executable did not identify itself as Blender.');
  const match = stdout.match(/^Blender (\d+)\.(\d+)/m)!;
  if (+match[1] < 4 || (+match[1] === 4 && +match[2] < 2)) throw new Error('Blender 4.2 or newer is required.');
  return resolved;
}

export function rememberBlender(executable: string): void {
  fs.mkdirSync(engineRoot(), { recursive: true });
  fs.writeFileSync(path.join(engineRoot(), 'engine.json'), JSON.stringify({ executable }));
}

export function findBlender(): string | undefined {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(engineRoot(), 'engine.json'), 'utf8')).executable;
    if (typeof saved === 'string' && path.isAbsolute(saved) && fs.existsSync(saved)) return saved;
  } catch { /* No configured engine yet. */ }
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    const base = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Blender Foundation');
    try { for (const dir of fs.readdirSync(base).sort().reverse()) candidates.push(path.join(base, dir, 'blender.exe')); } catch { /* Not installed. */ }
  } else if (process.platform === 'darwin') candidates.push('/Applications/Blender.app/Contents/MacOS/Blender');
  for (const directory of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) candidates.push(path.join(directory, process.platform === 'win32' ? 'blender.exe' : 'blender'));
  return candidates.find(candidate => { try { return fs.statSync(candidate).isFile(); } catch { return false; } });
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function install(): Promise<string> {
  const asset = blenderAsset();
  const root = engineRoot();
  fs.mkdirSync(root, { recursive: true });
  // A fresh, fixed-child staging folder never mixes two releases.
  const staging = fs.mkdtempSync(path.join(root, 'install-'));
  const archive = path.join(staging, asset);
  const unpacked = path.join(staging, 'runtime');
  fs.mkdirSync(unpacked);
  try {
    const manifest = await fetch(`${RELEASE}blender-${BLENDER_VERSION}.sha256`, { signal: AbortSignal.timeout(30_000) });
    if (!manifest.ok) throw new Error(`Blender checksums: HTTP ${manifest.status}`);
    const line = (await manifest.text()).split(/\r?\n/).find(line => line.trim().endsWith(asset));
    const expected = line?.trim().split(/\s+/)[0];
    if (!expected || !/^[a-f0-9]{64}$/i.test(expected)) throw new Error('The official Blender checksum is missing.');
    await trackDownload({ url: RELEASE + asset, dest: archive, label: `Blender ${BLENDER_VERSION}`, category: 'engine' });
    if ((await hashFile(archive)).toLowerCase() !== expected.toLowerCase()) throw new Error('Blender download checksum mismatch. Please retry.');
    let binary: string;
    if (asset.endsWith('.zip')) {
      await extractArchive(asset, archive, unpacked, 'Blender');
      const folder = fs.readdirSync(unpacked).find(name => name.startsWith('blender-'));
      if (!folder) throw new Error('Blender archive has no runtime folder.');
      binary = path.join(unpacked, folder, 'blender.exe');
    } else if (asset.endsWith('.tar.xz')) {
      const listing = await exec('tar', ['-tf', archive], { windowsHide: true, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
      listing.stdout.split(/\r?\n/).filter(Boolean).forEach(ensureSafeEntryPath);
      await exec('tar', ['-xf', archive, '-C', unpacked], { windowsHide: true, timeout: 180_000 });
      const folder = fs.readdirSync(unpacked).find(name => name.startsWith('blender-'));
      if (!folder) throw new Error('Blender archive has no runtime folder.');
      binary = path.join(unpacked, folder, 'blender');
    } else {
      const mount = path.join(staging, 'mount'); fs.mkdirSync(mount);
      await exec('hdiutil', ['attach', archive, '-readonly', '-nobrowse', '-mountpoint', mount], { timeout: 60_000 });
      try { await fs.promises.cp(path.join(mount, 'Blender.app'), path.join(unpacked, 'Blender.app'), { recursive: true }); }
      finally { await exec('hdiutil', ['detach', mount], { timeout: 30_000 }); }
      binary = path.join(unpacked, 'Blender.app', 'Contents', 'MacOS', 'Blender');
    }
    await checkBlender(binary);
    const destination = path.join(root, `blender-${BLENDER_VERSION}-${Date.now()}`);
    fs.renameSync(unpacked, destination);
    const installed = path.join(destination, path.relative(unpacked, binary));
    rememberBlender(installed);
    return installed;
  } finally {
    // staging was created by mkdtemp beneath the managed engine root.
    const resolved = path.resolve(staging);
    if (path.dirname(resolved) === path.resolve(root) && path.basename(resolved).startsWith('install-')) fs.rmSync(resolved, { recursive: true, force: true });
  }
}

export function installBlender(): Promise<string> {
  installing ??= install().finally(() => { installing = undefined; });
  return installing;
}

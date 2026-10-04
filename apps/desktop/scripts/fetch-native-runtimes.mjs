// ── Bundled local runtimes, from the upstream releases ─────────────────
// Desktop ships llama.cpp (llama-server) and whisper.cpp (whisper-cli) so
// local models work out of the box. Instead of compiling them, the build
// downloads the binaries ggml-org publishes on each project's GitHub
// releases, checks each archive against the SHA-256 GitHub records for it,
// and unpacks it into resources/bin/<engine>/<backend>/ (git-ignored), where
// runtime-resolver.ts and whisper-resolver.ts look.
//
// Environment:
//   NATIVE_RUNTIME_PLATFORM  linux | windows | macos   (default: this machine)
//   NATIVE_RUNTIME_ARCH      x64 | arm64                (default: this machine)
//   NATIVE_RUNTIME_ENGINES   e.g. "audio"               (default: all engines)
//   NATIVE_RUNTIME_BACKENDS  e.g. "cpu,vulkan"          (default: published backends except ROCm)
//   LLAMA_CPP_TAG / WHISPER_CPP_TAG / AUDIO_CPP_TAG  release to use (defaults below)
//   GITHUB_TOKEN             optional, avoids the API rate limit in CI
//
// Releases include CPU, Vulkan (any GPU), CUDA with its runtime and SYCL
// (Intel), wherever published. ROCm (AMD) is downloaded through the UI.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_ROOT = path.join(ROOT, 'resources', 'bin');

const PLATFORM = process.env.NATIVE_RUNTIME_PLATFORM || (
  process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
);
const ARCH = process.env.NATIVE_RUNTIME_ARCH || (process.arch === 'arm64' ? 'arm64' : 'x64');
const SELECTED_ENGINES = (process.env.NATIVE_RUNTIME_ENGINES || '').split(',').map(value => value.trim()).filter(Boolean);
const BACKENDS = (process.env.NATIVE_RUNTIME_BACKENDS || '')
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);

/** What each engine publishes, per platform-arch and backend ({tag} is filled in). */
const ENGINES = [
  {
    engine: 'llama',
    repo: 'ggml-org/llama.cpp',
    // The build the stable v0.5.0 release points at (its nightly-tag.txt).
    tag: process.env.LLAMA_CPP_TAG || 'b11146',
    executables: ['llama-server', 'llama-cli'],
    assets: {
      'linux-x64': {
        cpu: ['llama-{tag}-bin-ubuntu-x64.tar.gz'],
        vulkan: ['llama-{tag}-bin-ubuntu-vulkan-x64.tar.gz'],
        cuda: ['llama-{tag}-bin-ubuntu-cuda-12.8-x64.tar.gz', 'cudart-llama-{tag}-bin-ubuntu-cuda-12.8-x64.tar.gz'],
        rocm: ['llama-{tag}-bin-ubuntu-rocm-10.0-x64.tar.gz'],
        sycl: ['llama-{tag}-bin-ubuntu-sycl-fp16-x64.tar.gz']
      },
      'linux-arm64': {
        cpu: ['llama-{tag}-bin-ubuntu-arm64.tar.gz'],
        vulkan: ['llama-{tag}-bin-ubuntu-vulkan-arm64.tar.gz'],
        // Only CUDA 13 is published for arm64 (Jetson Thor, GH200-class).
        cuda: ['llama-{tag}-bin-ubuntu-cuda-13.4-arm64.tar.gz', 'cudart-llama-{tag}-bin-ubuntu-cuda-13.4-arm64.tar.gz']
      },
      'windows-x64': {
        cpu: ['llama-{tag}-bin-win-cpu-x64.zip'],
        vulkan: ['llama-{tag}-bin-win-vulkan-x64.zip'],
        cuda: ['llama-{tag}-bin-win-cuda-12.4-x64.zip', 'cudart-llama-bin-win-cuda-12.4-x64.zip'],
        rocm: ['llama-{tag}-bin-win-rocm-10.0-x64.zip'],
        sycl: ['llama-{tag}-bin-win-sycl-x64.zip']
      },
      'macos-arm64': { metal: ['llama-{tag}-bin-macos-arm64.tar.gz'] },
      'macos-x64': { metal: ['llama-{tag}-bin-macos-x64.tar.gz'] }
    }
  },
  {
    engine: 'audio',
    repo: '0xShug0/audio.cpp',
    tag: process.env.AUDIO_CPP_TAG || 'v0.8.2',
    executables: ['audiocpp_server'],
    // The server reads each model family's definition from model_specs/.
    folders: ['model_specs'],
    // Text to speech (Settings → Voice). CPU builds run everywhere; the
    // models are downloaded by the user in the app.
    assets: {
      'linux-x64': { cpu: ['audio-{tag}-bin-ubuntu-x64-cpu-portable.tar.gz'], vulkan: ['audio-{tag}-bin-ubuntu-x64-vulkan-portable.tar.gz'] },
      'windows-x64': { cpu: ['audio-{tag}-bin-windows-x64-cpu-portable.zip'], vulkan: ['audio-{tag}-bin-windows-x64-vulkan.zip'] }
    }
  },
  {
    engine: 'whisper',
    repo: 'ggml-org/whisper.cpp',
    tag: process.env.WHISPER_CPP_TAG || 'b5130',
    executables: ['whisper-cli', 'whisper-server', 'main'],
    // whisper.cpp publishes CPU builds for every OS; its only GPU build
    // (Windows CUDA) is 674 MB, and speech-to-text is quick on the CPU.
    assets: {
      'linux-x64': { cpu: ['whisper-bin-ubuntu-x64.tar.gz'] },
      'linux-arm64': { cpu: ['whisper-bin-ubuntu-arm64.tar.gz'] },
      'windows-x64': { cpu: ['whisper-bin-x64.zip'] }
    }
  }
];

const LIBRARY = /\.(so(\.\d+)*|dll|dylib|metallib)$/i;

function wanted(backend) {
  return BACKENDS.length ? BACKENDS.includes(backend) : backend !== 'rocm';
}

async function github(url) {
  const headers = { 'User-Agent': 'agente-desktop-build', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

/** Check `bytes` against the SHA-256 GitHub recorded for the asset. */
function verify(asset, bytes) {
  const [algorithm, expected] = String(asset.digest || '').split(':');
  if (algorithm !== 'sha256') {
    console.warn(`[native] ${asset.name}: GitHub recorded no checksum; not verified`);
    return;
  }
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new Error(`${asset.name}: checksum mismatch`);
}

async function download(asset, file) {
  console.log(`[native] ↓ ${asset.name} (${Math.round(asset.size / 1e6)} MB)`);
  const response = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'agente-desktop-build' } });
  if (!response.ok) throw new Error(`${asset.browser_download_url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  verify(asset, bytes);
  fs.writeFileSync(file, bytes);
}

function extract(archive, into) {
  fs.mkdirSync(into, { recursive: true });
  // bsdtar (Windows 10+, macOS) reads zip and tar.gz; GNU tar on Linux only
  // ever gets tar.gz here.
  const result = spawnSync('tar', ['-xf', archive, '-C', into], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`could not unpack ${archive}`);
}

/** Every directory under `dir` that holds files. */
function directories(dir) {
  const found = [];
  const walk = (current) => {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    if (entries.some((entry) => !entry.isDirectory())) found.push(current);
    for (const entry of entries) if (entry.isDirectory()) walk(path.join(current, entry.name));
  };
  walk(dir);
  return found;
}

/** Worth shipping: the app's executables, their libraries, the licenses. */
function ships(name, executables) {
  return executables.has(name) || LIBRARY.test(name) || /^LICENSE/i.test(name);
}

/** The files of `unpacked` worth shipping. */
function shippedFiles(unpacked, executables) {
  return directories(unpacked).flatMap((dir) =>
    fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !entry.isDirectory() && ships(entry.name, executables))
      .map((entry) => path.join(dir, entry.name))
  );
}

/** Folders that ship whole (audio.cpp's model_specs). */
function copyFolders(unpacked, outDir, folders) {
  for (const name of folders ?? []) {
    const found = directories(unpacked).map((dir) => path.join(dir, name)).find((dir) => fs.existsSync(dir));
    if (found) fs.cpSync(found, path.join(outDir, name), { recursive: true });
  }
}

/** Copy what ships into `outDir`; returns how many executables it held. */
function install(unpacked, outDir, executables) {
  let count = 0;
  for (const file of shippedFiles(unpacked, executables)) {
    const target = path.join(outDir, path.basename(file));
    fs.rmSync(target, { force: true });
    // Keep versioned-library symlinks (libllama.so -> libllama.so.0) as links.
    fs.cpSync(file, target, { verbatimSymlinks: true });
    if (executables.has(path.basename(file))) {
      if (process.platform !== 'win32') fs.chmodSync(target, 0o755);
      count += 1;
    }
  }
  return count;
}

function writeBuildInfo(outDir, spec, backend, sources) {
  fs.writeFileSync(path.join(outDir, 'BUILD_INFO.txt'), [
    `engine=${spec.engine}`,
    `repo=https://github.com/${spec.repo}`,
    `release=${spec.tag}`,
    `backend=${backend}`,
    `platform=${PLATFORM}`,
    `arch=${ARCH}`,
    ...sources.map((url) => `source=${url}`)
  ].join(os.EOL) + os.EOL);
}

/** Download and unpack one backend's archives into resources/bin/<engine>/<backend>. */
async function fetchBackend(spec, backend, names, assets, work) {
  const targetDir = path.join(OUT_ROOT, spec.engine, backend);
  const outDir = path.join(work, `${spec.engine}-${backend}-install`);
  fs.mkdirSync(outDir, { recursive: true });
  const executables = new Set(spec.executables.flatMap((name) => [name, `${name}.exe`]));
  let found = 0;
  const sources = [];
  for (const name of names.map((template) => template.replaceAll('{tag}', spec.tag))) {
    const asset = assets.get(name);
    if (!asset) throw new Error(`${spec.repo} ${spec.tag} has no ${name}`);
    const archive = path.join(work, name);
    await download(asset, archive);
    extract(archive, `${archive}.d`);
    found += install(`${archive}.d`, outDir, executables);
    copyFolders(`${archive}.d`, outDir, spec.folders);
    sources.push(asset.browser_download_url);
  }
  if (!found) throw new Error(`${spec.engine}/${backend}: no ${spec.executables.join(' or ')} in the archives`);
  writeBuildInfo(outDir, spec, backend, sources);
  // Keep the installed runtime usable throughout downloads and verification.
  const staged = `${targetDir}.install-${process.pid}`;
  fs.cpSync(outDir, staged, { recursive: true });
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.renameSync(staged, targetDir);
  console.log(`[native] ${spec.engine}/${backend} ready`);
}

async function fetchEngine(spec, key, work) {
  const byBackend = spec.assets[key];
  if (!byBackend) {
    console.log(`[native] ${spec.engine}: nothing published for ${key}; skipped`);
    return;
  }
  const release = await github(`https://api.github.com/repos/${spec.repo}/releases/tags/${spec.tag}`);
  const assets = new Map(release.assets.map((asset) => [asset.name, asset]));
  for (const [backend, names] of Object.entries(byBackend)) {
    if (wanted(backend)) await fetchBackend(spec, backend, names, assets, work);
  }
}

const key = `${PLATFORM}-${ARCH}`;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agente-native-'));
try {
  fs.mkdirSync(OUT_ROOT, { recursive: true });
  for (const spec of ENGINES) {
    if (SELECTED_ENGINES.length && !SELECTED_ENGINES.includes(spec.engine)) continue;
    await fetchEngine(spec, key, work);
  }
  console.log(`[native] Done: ${OUT_ROOT}`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

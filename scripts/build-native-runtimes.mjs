import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_ROOT = path.join(ROOT, 'resources', 'bin');
const SRC_ROOT = path.join(ROOT, '.native-src');
const BUILD_ROOT = path.join(ROOT, '.native-build');

const PLATFORM = process.env.NATIVE_RUNTIME_PLATFORM || (
  process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
);
const ARCH = process.env.NATIVE_RUNTIME_ARCH || (process.arch === 'arm64' ? 'arm64' : 'x64');
const CLEAN = String(process.env.NATIVE_RUNTIME_CLEAN || 'true').toLowerCase() !== 'false';
const BACKEND_FILTER = new Set(
  String(process.env.NATIVE_RUNTIME_BACKENDS || '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)
);

const targets = [
  {
    engine: 'llama',
    repo: 'https://github.com/ggml-org/llama.cpp.git',
    ref: process.env.LLAMA_CPP_REF || process.env.LLAMA_CPP_TAG || 'master',
    cmakeTargets: ['llama-server', 'llama-cli'],
    binNames: ['llama-server', 'llama-cli'],
  },
  {
    engine: 'whisper',
    repo: 'https://github.com/ggml-org/whisper.cpp.git',
    ref: process.env.WHISPER_CPP_REF || process.env.WHISPER_CPP_TAG || 'master',
    cmakeTargets: ['whisper-cli'],
    binNames: ['whisper-cli', 'main'],
  },
];

function platformBackends() {
  let backends;
  if (PLATFORM === 'macos') backends = ['metal', 'cpu'];
  else if (PLATFORM === 'windows' || PLATFORM === 'linux') backends = ['cpu', 'vulkan', 'cuda'];
  else backends = ['cpu'];
  return BACKEND_FILTER.size ? backends.filter(backend => BACKEND_FILTER.has(backend)) : backends;
}

function exe(name) {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

function run(command, args, options = {}) {
  console.log(`[native] $ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

function cloneSource(target) {
  const dir = path.join(SRC_ROOT, target.engine);
  if (fs.existsSync(path.join(dir, '.git'))) return dir;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  run('git', ['clone', '--depth', '1', '--branch', target.ref, target.repo, dir]);
  return dir;
}

function backendFlags(backend) {
  const flags = ['-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF'];
  if (backend === 'cpu') {
    flags.push('-DGGML_NATIVE=OFF');
  } else if (backend === 'vulkan') {
    flags.push('-DGGML_VULKAN=ON', '-DGGML_NATIVE=OFF');
  } else if (backend === 'cuda') {
    flags.push('-DGGML_CUDA=ON', '-DGGML_NATIVE=OFF');
  } else if (backend === 'metal') {
    flags.push('-DGGML_METAL=ON', '-DGGML_NATIVE=OFF');
  }
  return flags;
}

function cmakeGeneratorArgs() {
  if (process.platform === 'win32') return ['-G', 'Visual Studio 17 2022', '-A', ARCH === 'arm64' ? 'ARM64' : 'x64'];
  return [];
}

function copyIfRuntimeDependency(filePath, outDir) {
  const name = path.basename(filePath).toLowerCase();
  if (process.platform === 'win32' && !name.endsWith('.dll')) return;
  if (process.platform === 'darwin' && !name.endsWith('.dylib') && !name.endsWith('.metallib')) return;
  if (process.platform !== 'win32' && process.platform !== 'darwin' && !name.endsWith('.so')) return;
  fs.copyFileSync(filePath, path.join(outDir, path.basename(filePath)));
}

function collectBuiltFiles(buildDir, target, backend) {
  const outDir = path.join(OUT_ROOT, target.engine, backend);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const wanted = new Set(target.binNames.flatMap(name => [name, exe(name)]));
  const copied = new Set();

  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (wanted.has(entry.name)) {
        fs.copyFileSync(full, path.join(outDir, entry.name));
        if (process.platform !== 'win32') fs.chmodSync(path.join(outDir, entry.name), 0o755);
        copied.add(entry.name);
        continue;
      }
      copyIfRuntimeDependency(full, outDir);
    }
  }
  walk(buildDir);

  if (!copied.size) {
    throw new Error(`No ${target.engine} binaries were produced for ${backend} in ${buildDir}`);
  }

  fs.writeFileSync(path.join(outDir, 'BUILD_INFO.txt'), [
    `engine=${target.engine}`,
    `repo=${target.repo}`,
    `ref=${target.ref}`,
    `backend=${backend}`,
    `platform=${PLATFORM}`,
    `arch=${ARCH}`,
    `built_at=${new Date().toISOString()}`,
  ].join(os.EOL));
  console.log(`[native] ${target.engine}/${backend}: ${[...copied].join(', ')}`);
}

function buildTarget(target, backend) {
  const sourceDir = cloneSource(target);
  const buildDir = path.join(BUILD_ROOT, target.engine, backend);
  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(buildDir, { recursive: true });

  run('cmake', [
    '-S', sourceDir,
    '-B', buildDir,
    ...cmakeGeneratorArgs(),
    ...backendFlags(backend),
  ]);

  run('cmake', [
    '--build', buildDir,
    '--config', 'Release',
    '--parallel', String(Math.max(2, os.cpus().length)),
    '--target', ...target.cmakeTargets,
  ]);

  collectBuiltFiles(buildDir, target, backend);
}

if (CLEAN) {
  fs.rmSync(OUT_ROOT, { recursive: true, force: true });
  fs.rmSync(BUILD_ROOT, { recursive: true, force: true });
}
fs.mkdirSync(OUT_ROOT, { recursive: true });

const backends = platformBackends();
console.log(`[native] Building ${backends.join(', ')} runtimes for ${PLATFORM}/${ARCH}`);
for (const target of targets) {
  for (const backend of backends) {
    buildTarget(target, backend);
  }
}
console.log(`[native] Done: ${OUT_ROOT}`);

#!/usr/bin/env node
// Copies the Rust runtime (`agente`) built at the workspace root into
// resources/bin, which the app ships as its bundled binaries (the Code
// section runs on it: main/agente-daemon.ts finds it there when packaged).
//
//   npm run build:agente   cargo build --release, then this copy

import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: on Windows the latter is "/D:/…".
const root = fileURLToPath(new URL('..', import.meta.url));
const exe = process.platform === 'win32' ? 'agente.exe' : 'agente';
const source = path.resolve(root, '..', '..', 'target', 'release', exe);
const target = path.join(root, 'resources', 'bin', exe);

if (!existsSync(source)) {
  console.error(`${source} not found: run cargo build --release --bin agente at the workspace root first`);
  process.exit(1);
}
mkdirSync(path.dirname(target), { recursive: true });
copyFileSync(source, target);
chmodSync(target, 0o755);
console.log(`bundled ${path.relative(root, target)} (${(statSync(target).size / 1e6).toFixed(1)} MB)`);
if (process.platform === 'win32') {
  const helper = path.resolve(root, '..', '..', 'target', 'release', 'agente-computer.exe');
  if (!existsSync(helper)) throw new Error('Build agente-computer before packaging the desktop app.');
  const helperTarget = path.join(root, 'resources', 'bin', 'agente-computer.exe');
  copyFileSync(helper, helperTarget);
  console.log(`bundled ${path.relative(root, helperTarget)}`);
}

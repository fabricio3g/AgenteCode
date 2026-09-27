#!/usr/bin/env node
// Copies the Rust runtime (`agente`) built at the workspace root into
// resources/bin, which the app ships as its bundled binaries (the Code
// section runs on it: main/agente-daemon.ts finds it there when packaged).
//
//   npm run build:agente   cargo build --release, then this copy

import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname;
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

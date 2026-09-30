#!/usr/bin/env node
// Live conversation probe using the desktop's selected provider and credentials.
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpRoot = process.env.TMPDIR || '/tmp/opencode';
mkdirSync(tmpRoot, { recursive: true });
const temp = mkdtempSync(path.join(tmpRoot, 'roleplay-smoke-'));
try {
  const outfile = path.join(temp, 'probe.mjs');
  const require = createRequire(import.meta.url);
  await build({ entryPoints: [path.join(root, 'scripts/roleplay-smoke-entry.ts')], outfile,
    bundle: true, platform: 'node', format: 'esm', external: ['electron', require.resolve('better-sqlite3')],
    banner: { js: `import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(${JSON.stringify(path.join(root, 'package.json'))});` },
    alias: { 'better-sqlite3': require.resolve('better-sqlite3') } });
  const child = spawn(require('electron'), ['--no-sandbox', outfile], {
    cwd: root, stdio: 'inherit', env: { ...process.env, ROLEPLAY_PROJECT_ROOT: root }
  });
  process.exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code) => resolve(code ?? 1)); });
} finally { rmSync(temp, { recursive: true, force: true }); }

// Builds the Agente browser extension for Chrome and Firefox from one source
// (apps/desktop/extension): esbuild bundles, two generated manifests, the
// brand icons. Output: dist-extension/{chrome,firefox}, ready for "Load
// unpacked" (chrome://extensions) or "Load Temporary Add-on" (about:debugging).
//
// Usage (from apps/desktop):
//   node scripts/build-extension.mjs           # both browsers
//   node scripts/build-extension.mjs --watch   # rebuild on change

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { build, context } from 'esbuild';
import { SNAPSHOT_SCRIPT } from '../shared/browser/snapshot.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'extension', 'src');
const brand = path.resolve(root, '..', '..', 'assets', 'brand');
const out = path.join(root, 'dist-extension');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const watch = process.argv.includes('--watch');

const ICON_SIZES = [16, 32, 48, 128];
const icons = Object.fromEntries(ICON_SIZES.map((size) => [String(size), `icon-${size}.png`]));

const base = {
  manifest_version: 3,
  name: 'Agente',
  version,
  description: 'Chat with Agente about the page you are on, and let your Agente sessions work in this browser — your tabs, logins, Google Docs and Sheets.',
  icons,
  action: { default_title: 'Agente', default_icon: icons },
  permissions: ['tabs', 'scripting', 'storage', 'alarms'],
  host_permissions: ['<all_urls>'],
  // Firefox's MV3 default adds `upgrade-insecure-requests`, which turns the
  // bridge's ws://127.0.0.1 into wss:// and the socket never opens.
  content_security_policy: { extension_pages: "script-src 'self'" },
  content_scripts: [
    // The page's own world, before its scripts: console capture for browser_console.
    { matches: ['<all_urls>'], js: ['console-hook.js'], run_at: 'document_start', world: 'MAIN' }
  ]
};

const manifests = {
  chrome: {
    ...base,
    minimum_chrome_version: '116',
    permissions: [...base.permissions, 'sidePanel'],
    background: { service_worker: 'background.js' },
    side_panel: { default_path: 'panel/panel.html' }
  },
  firefox: {
    ...base,
    // Firefox MV3 runs the background as an event page, not a service worker.
    background: { scripts: ['background.js'] },
    sidebar_action: { default_panel: 'panel/panel.html', default_title: 'Agente', default_icon: icons, open_at_install: false },
    browser_specific_settings: { gecko: { id: 'agente-extension@agente.dev', strict_min_version: '128.0' } }
  }
};

// The panel driver and the extension share one snapshot script; the extension
// cannot eval a string, so it gets the same source as a real function.
const snapshotModule = {
  name: 'agente-snapshot',
  setup(builder) {
    builder.onResolve({ filter: /^agente:snapshot$/ }, () => ({ path: 'snapshot', namespace: 'agente' }));
    builder.onLoad({ filter: /.*/, namespace: 'agente' }, () => ({
      contents: `export function snapshotPage() { return ${SNAPSHOT_SCRIPT}; }`,
      loader: 'js'
    }));
  }
};

function copyStatic(target) {
  const dir = path.join(out, target);
  fs.mkdirSync(path.join(dir, 'panel'), { recursive: true });
  for (const file of ['panel.html', 'panel.css']) {
    fs.copyFileSync(path.join(source, 'panel', file), path.join(dir, 'panel', file));
  }
  for (const size of ICON_SIZES) {
    fs.copyFileSync(path.join(brand, `agente-code-icon-${size}.png`), path.join(dir, `icon-${size}.png`));
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifests[target], null, 2)}\n`);
}

function options(target) {
  return {
    entryPoints: {
      background: path.join(source, 'background.ts'),
      'console-hook': path.join(source, 'console-hook.ts'),
      'panel/panel': path.join(source, 'panel', 'panel.ts')
    },
    outdir: path.join(out, target),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    // Page functions are shipped to tabs by source text: no helpers, no renames.
    target: 'es2022',
    keepNames: false,
    minify: false,
    sourcemap: watch ? 'inline' : false,
    logLevel: 'info',
    plugins: [snapshotModule]
  };
}

fs.rmSync(out, { recursive: true, force: true });
for (const target of Object.keys(manifests)) {
  copyStatic(target);
  if (watch) {
    const ctx = await context(options(target));
    await ctx.watch();
  } else {
    await build(options(target));
  }
}
if (!watch) console.log(`Extension built: ${path.relative(process.cwd(), out)}/{chrome,firefox} (v${version})`);

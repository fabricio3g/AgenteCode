// Bundles the Electron main-process entry points with esbuild.
//
// This is the single source of truth for what may NOT be bundled: every
// package here is a native addon or a prebuilt runtime that electron-builder
// copies verbatim (see the `build.files` / `asarUnpack` config), so esbuild
// must resolve it at runtime instead of inlining it.
//
// Usage (from the repo root):
//   node scripts/build-bundles.mjs main tts --minify   # production
//   node scripts/build-bundles.mjs main --watch        # dev, stays alive

import process from 'node:process';
import { build, context } from 'esbuild';

// Shared by every main-process bundle.
const RUNTIME_EXTERNALS = [
  'electron',
  'better-sqlite3',
  '@lancedb/*',
  'apache-arrow',
  '@huggingface/transformers',
  'onnxruntime-node',
  'kokoro-js',
];

// The main bundle imports these through optionalDependencies or the OTel API
// shim; they are resolved lazily at runtime, never bundled.
const MAIN_ONLY_EXTERNALS = ['sherpa-onnx-node', '@opentelemetry/api'];

const BUNDLES = {
  main: {
    entry: 'main/index.ts',
    outfile: 'dist-electron/main/index.cjs',
    // esbuild emits CJS, so `import.meta.url` has no value; the main process
    // reads it to locate resources next to the bundle.
    define: { 'import.meta.url': '__filename' },
    extraExternals: MAIN_ONLY_EXTERNALS,
  },
  tts: {
    entry: 'main/tts-worker.ts',
    outfile: 'dist-electron/main/tts-worker.cjs',
    extraExternals: [],
  },
};

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
const names = argv.filter((arg) => !arg.startsWith('--'));
const minify = flags.has('--minify');
const watch = flags.has('--watch');

const unknown = names.filter((name) => !BUNDLES[name]);
if (unknown.length || !names.length) {
  console.error(
    `Usage: node scripts/build-bundles.mjs <${Object.keys(BUNDLES).join('|')}> [...targets] [--minify] [--watch]`
  );
  process.exit(1);
}

function optionsFor(name) {
  const bundle = BUNDLES[name];
  return {
    entryPoints: [bundle.entry],
    outfile: bundle.outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    minify,
    external: [...RUNTIME_EXTERNALS, ...bundle.extraExternals],
    ...(bundle.define ? { define: bundle.define } : {}),
  };
}

if (watch) {
  // One long-lived context per target; concurrently -k owns the lifecycle.
  for (const name of names) {
    const ctx = await context(optionsFor(name));
    await ctx.watch();
    console.log(`[esbuild] watching ${name} -> ${BUNDLES[name].outfile}`);
  }
} else {
  await Promise.all(names.map((name) => build(optionsFor(name))));
}

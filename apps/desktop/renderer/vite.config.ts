import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'node:path';
import monacoEditorModule from 'vite-plugin-monaco-editor';
import { windowThemeBootstrap, windowThemeCss } from '../shared/window-theme';

export default defineConfig({
  base: './',
  plugins: [
    {
      name: 'window-theme-bootstrap',
      transformIndexHtml: {
        order: 'pre',
        handler: () => [
          { tag: 'style', children: windowThemeCss(), injectTo: 'head-prepend' },
          { tag: 'script', children: windowThemeBootstrap(), injectTo: 'head-prepend' }
        ]
      }
    },
    svelte(),
    (monacoEditorModule as any).default({
      languageWorkers: ['editorWorkerService', 'css', 'html', 'json', 'typescript']
    })
  ],
  resolve: {
    alias: {
      $lib: path.resolve(__dirname, 'src/lib'),
      $shared: path.resolve(__dirname, '../shared'),
      // The startup screen's tile field is the landing page's field: the site
      // serves it as a plain module, the renderer imports that same file, so
      // the mosaic has one implementation and the two can never drift.
      $site: path.resolve(__dirname, '../../../site'),
      'kokoro-js': path.resolve(__dirname, 'node_modules/kokoro-js/dist/kokoro.web.js')
    }
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // Vite rejects unknown Host headers, so a quick tunnel's random
    // `*.trycloudflare.com` name needs to be allowed explicitly. Patterns with
    // a leading dot cover every subdomain, since the name changes per tunnel.
    allowedHosts: ['.trycloudflare.com'],
    fs: {
      // `$site` sits outside the workspace root, and setting `allow` replaces
      // the default, so the app's own root is listed again.
      allow: [path.resolve(__dirname, '..'), path.resolve(__dirname, '../../../site')]
    }
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    strictPort: true,
    // Same Host check as the dev server: a quick tunnel's name is random.
    allowedHosts: ['.trycloudflare.com']
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        // Tesseract requests <language>.traineddata.gz below langPath. Unlike
        // JS/CSS assets, that filename is part of its protocol and stays exact.
        assetFileNames: (asset) => asset.names.some((name) => name.endsWith('.traineddata.gz'))
          ? 'assets/ocr/[name][extname]' : 'assets/[name]-[hash][extname]',
      },
    },
    // Local Electron assets include Monaco and office libraries. Keep a
    // 5 MiB chunk budget; CI still rejects build diagnostics and regressions.
    chunkSizeWarningLimit: 5 * 1024,
    // es2022 (not es2021) because src/main.ts awaits the dev-only mock-electron
    // import at top level. esbuild only allows a feature if *every* listed
    // target supports it, so listing es2021 here fails the whole build.
    target: ['es2022', 'chrome100']
  },
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,js}']
  }
});

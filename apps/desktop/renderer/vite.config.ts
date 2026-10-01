import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'node:path';
import monacoEditorModule from 'vite-plugin-monaco-editor';

export default defineConfig({
  base: './',
  plugins: [
    svelte(),
    (monacoEditorModule as any).default({
      languageWorkers: ['editorWorkerService', 'css', 'html', 'json', 'typescript']
    })
  ],
  resolve: {
    alias: {
      $lib: path.resolve(__dirname, 'src/lib'),
      $shared: path.resolve(__dirname, '../shared'),
      'kokoro-js': path.resolve(__dirname, 'node_modules/kokoro-js/dist/kokoro.web.js')
    }
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    strictPort: true
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
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

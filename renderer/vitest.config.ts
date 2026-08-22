import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'node:path';

// Component tests intentionally omit Monaco. Its worker plugin is production
// build infrastructure and can keep Vitest's process alive after the suite.
export default defineConfig({
  plugins: [svelte()],
  resolve: {
    conditions: ['browser'],
    alias: {
      $lib: path.resolve(__dirname, 'src/lib'),
      $shared: path.resolve(__dirname, '../shared'),
      'kokoro-js': path.resolve(__dirname, 'node_modules/kokoro-js/dist/kokoro.web.js'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,js}'],
    setupFiles: ['./src/test/setup.ts'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    teardownTimeout: 5_000,
    pool: 'forks',
    maxWorkers: 4,
    minWorkers: 1,
    isolate: true,
  },
});

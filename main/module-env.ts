/**
 * Module-environment shims for `main/`, which runs two ways:
 *
 * - bundled to CJS by esbuild for the Electron app, where `__dirname` and
 *   `require` are real bindings;
 * - as ESM under tsx for the test suite, where they are not.
 *
 * `typeof` on an undeclared identifier is defined behaviour in both, so the
 * guards below resolve without `eval`. The ESM branches reference
 * `import.meta.url`, which esbuild rewrites in the CJS build via the
 * `--define:import.meta.url=__filename` flag in package.json — dead code
 * there, but compilable without an `empty-import-meta` warning.
 */

import path from 'node:path';
import { createRequire } from 'node:module';

export const moduleRequire: NodeRequire =
  typeof require === 'function' ? require : createRequire(import.meta.url);

/**
 * Directory of the calling module.
 *
 * Pass `import.meta.url` from the caller so the ESM path resolves relative to
 * that module rather than to this one. Ignored in the CJS bundle, where every
 * module shares the bundle's own `__dirname`.
 */
export function moduleDirname(metaUrl?: string): string {
  if (typeof __dirname === 'string' && __dirname) return __dirname;

  if (typeof metaUrl === 'string' && metaUrl) {
    try {
      const { fileURLToPath } = moduleRequire('node:url');
      return path.dirname(fileURLToPath(metaUrl));
    } catch {
      // Fall through to cwd below.
    }
  }

  return process.cwd();
}

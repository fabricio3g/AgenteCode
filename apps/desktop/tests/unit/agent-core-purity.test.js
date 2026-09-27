import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const coreDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../shared/agent-core');

function importSpecifiers(source) {
  return [...source.matchAll(/^\s*(?:import|export)[^'"\n]*from\s+['"]([^'"]+)['"]/gm)].map((match) => match[1]);
}

function externalImports(file) {
  const source = fs.readFileSync(path.join(coreDir, file), 'utf8');
  return importSpecifiers(source)
    .filter((specifier) => !specifier.startsWith('./'))
    .map((specifier) => `${file}: ${specifier}`);
}

/**
 * The loop and its types are shared by the main-process engine and the
 * renderer specs, so the boundary has to stay one-way: shared/agent-core may
 * only import itself. Node built-ins, Electron, main host modules and
 * renderer code would make the core process-specific again.
 */
describe('shared/agent-core purity', () => {
  it('only has relative imports inside the core', () => {
    const offenders = fs.readdirSync(coreDir)
      .filter((file) => file.endsWith('.ts'))
      .flatMap(externalImports);
    assert.deepEqual(offenders, []);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const coreDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../shared/agent-core');

/**
 * The loop and its types are shared by the main-process engine and the
 * renderer specs, so the boundary has to stay one-way: shared/agent-core may
 * only import itself. Anything else (Node built-ins, Electron, main host
 * modules, renderer code) would make the core process-specific again.
 */
describe('shared/agent-core purity', () => {
  it('only has relative imports inside the core', () => {
    const offenders = [];
    for (const file of fs.readdirSync(coreDir)) {
      if (!file.endsWith('.ts')) continue;
      const source = fs.readFileSync(path.join(coreDir, file), 'utf8');
      for (const match of source.matchAll(/^\s*(?:import|export)[^'"\n]*from\s+['"]([^'"]+)['"]/gm)) {
        const specifier = match[1];
        if (specifier.startsWith('./')) continue;
        offenders.push(`${file}: ${specifier}`);
      }
    }
    assert.deepEqual(offenders, []);
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function collectSvelteFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return collectSvelteFiles(path);
    return entry.isFile() && entry.name.endsWith('.svelte') ? [path] : [];
  });
}

describe('custom Select migration', () => {
  it('does not leave native select controls in renderer source', () => {
    const offenders = collectSvelteFiles(resolve(process.cwd(), 'src'))
      .filter((path) => /<select\b/.test(readFileSync(path, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

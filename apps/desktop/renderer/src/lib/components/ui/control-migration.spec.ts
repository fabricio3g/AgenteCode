import { readdirSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { parse } from 'svelte/compiler';
import { describe, expect, it } from 'vitest';
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? files(path) : entry.name.endsWith('.svelte') ? [path] : [];
  });
}
describe('shared UI boundary', () => {
  it('keeps native controls inside the UI library', () => {
    const root = resolve(process.cwd(), 'src');
    const offenders: string[] = [];
    function walk(node: unknown, file: string) {
      if (!node || typeof node !== 'object') return;
      const item = node as Record<string, unknown>;
      if (item.type === 'RegularElement' && ['button', 'input', 'textarea', 'select'].includes(String(item.name))) offenders.push(`${relative(root, file)}: ${item.name}`);
      for (const [key, value] of Object.entries(item)) {
        if (['metadata', 'loc'].includes(key)) continue;
        if (Array.isArray(value)) value.forEach(child => walk(child, file));
        else if (value && typeof value === 'object') walk(value, file);
      }
    }
    for (const file of files(root)) {
      if (file.replaceAll('\\', '/').includes('/lib/components/ui/')) continue;
      const ast = parse(readFileSync(file, 'utf8'), { modern: true });
      walk(ast.fragment, file);
    }
    expect(offenders).toEqual([]);
  });
});

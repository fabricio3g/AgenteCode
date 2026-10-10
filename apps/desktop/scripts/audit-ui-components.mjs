/** UI ownership inventory. Native controls belong in the primitive library. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const renderer = path.join(desktop, 'renderer');
const require = createRequire(path.join(renderer, 'package.json'));
const { parse } = require('svelte/compiler');
const root = path.join(renderer, 'src');
const ui = path.join(root, 'lib/components/ui');
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : entry.name.endsWith('.svelte') ? [file] : [];
  });
}
const counts = new Map();
const raw = [];
const surfaces = files(root);
for (const file of surfaces) {
  if (file.startsWith(ui + path.sep)) continue;
  const ast = parse(fs.readFileSync(file, 'utf8'), { modern: true });
  const imports = new Map();
  for (const entry of ast.instance?.content.body ?? []) {
    if (entry.type !== 'ImportDeclaration' || !entry.source.value.startsWith('$lib/components/ui')) continue;
    for (const spec of entry.specifiers) imports.set(spec.local.name, spec.type === 'ImportSpecifier' ? spec.imported.name : path.basename(entry.source.value, '.svelte'));
  }
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Component' && imports.has(node.name)) {
      const name = imports.get(node.name);
      const entry = counts.get(name) ?? { count: 0, files: new Set() };
      entry.count++; entry.files.add(path.relative(root, file)); counts.set(name, entry);
    }
    if (node.type === 'RegularElement' && ['button', 'input', 'textarea', 'select'].includes(node.name)) raw.push(`${path.relative(root, file)}: ${node.name}`);
    for (const [key, value] of Object.entries(node)) {
      if (['metadata', 'loc'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  }
  walk(ast.fragment);
}
console.log(`${surfaces.length} Svelte components; ${raw.length} native controls outside the shared library.\n`);
console.log('| Shared component | Uses | Screens/components |');
console.log('| --- | ---: | ---: |');
for (const [name, entry] of [...counts].sort(([a], [b]) => a.localeCompare(b))) console.log(`| ${name} | ${entry.count} | ${entry.files.size} |`);
if (raw.length) { console.error(raw.join('\n')); process.exitCode = 1; }

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createWriteTool } from '../../main/agente/tools/builtins.ts';

describe('write tool', () => {
  it('replaces by default and appends with append: true', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agente-write-'));
    const write = createWriteTool(root);
    const signal = new AbortController().signal;
    await write.execute('1', { path: 'big.js', content: 'part one\n' }, { signal });
    const appended = await write.execute('2', { path: 'big.js', content: 'part two\n', append: true }, { signal });
    assert.match(appended.content, /Appended 9 bytes to big\.js \(now 18 bytes\)/);
    assert.equal(fs.readFileSync(path.join(root, 'big.js'), 'utf8'), 'part one\npart two\n');
    await write.execute('3', { path: 'big.js', content: 'fresh\n' }, { signal });
    assert.equal(fs.readFileSync(path.join(root, 'big.js'), 'utf8'), 'fresh\n');
  });
});

describe('write guard', () => {
  it('refuses a fragment that would wipe a large file, and allows real rewrites', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agente-guard-'));
    const write = createWriteTool(root);
    const signal = new AbortController().signal;
    const big = '<!doctype html>\n' + 'x'.repeat(10_000);
    await write.execute('1', { path: 'index.html', content: big }, { signal });

    const fragment = await write.execute('2', { path: 'index.html', content: '\n  function drawEnemies() {}\n' }, { signal });
    assert.equal(fragment.isError, true);
    assert.match(fragment.content, /append: true/);
    assert.equal(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), big);

    const rewrite = await write.execute('3', { path: 'index.html', content: '<!doctype html>\n<p>smaller</p>\n' }, { signal });
    assert.notEqual(rewrite.isError, true);

    await write.execute('4', { path: 'index.html', content: big }, { signal });
    const forced = await write.execute('5', { path: 'index.html', content: 'fragment', overwrite: true }, { signal });
    assert.notEqual(forced.isError, true);
    assert.equal(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), 'fragment');
  });
});

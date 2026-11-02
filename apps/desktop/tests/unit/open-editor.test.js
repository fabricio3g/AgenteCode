import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { editorInvocation, openInEditor, resolveEditor, shellLine, splitCommand, which } from '../../main/agente/open-editor.ts';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agente-editor-'));
}

/** A fake editor on PATH that records the arguments it was launched with. */
function fakeEditor(dir, name = 'fake-editor') {
  const file = path.join(dir, name + (process.platform === 'win32' ? '.cmd' : ''));
  if (process.platform === 'win32') {
    const recorder = path.join(dir, `${name}-record.cjs`);
    fs.writeFileSync(recorder, "require('node:fs').writeFileSync(process.env.OUT, process.argv.slice(2).join('\\n') + '\\n');\n");
    fs.writeFileSync(file, `@echo off\r\n"${process.execPath}" "${recorder}" %*\r\n`);
    return file;
  }
  fs.writeFileSync(file, '#!/bin/sh\nprintf "%s\\n" "$@" > "$OUT"\n');
  fs.chmodSync(file, 0o755);
  return file;
}

describe('configured editor commands', () => {
  it('splits on whitespace and honours double quotes', () => {
    assert.deepEqual(splitCommand('code --wait'), ['code', '--wait']);
    assert.deepEqual(splitCommand('"/opt/My Editor/bin/code" --reuse-window'), ['/opt/My Editor/bin/code', '--reuse-window']);
    assert.deepEqual(splitCommand('   '), []);
  });
});

describe('editor invocations', () => {
  it('gives the VS Code family a goto argument', () => {
    assert.deepEqual(editorInvocation('code', '/p/a.ts', 12), { command: 'code', args: ['-g', '/p/a.ts:12'], terminal: false });
    assert.deepEqual(editorInvocation('cursor --reuse-window', '/p/a.ts', 3), { command: 'cursor', args: ['--reuse-window', '-g', '/p/a.ts:3'], terminal: false });
    assert.deepEqual(editorInvocation('code', '/p/a.ts'), { command: 'code', args: ['-g', '/p/a.ts'], terminal: false });
  });

  it('gives zed and subl a file:line argument', () => {
    assert.deepEqual(editorInvocation('zed', '/p/a.ts', 7), { command: 'zed', args: ['/p/a.ts:7'], terminal: false });
    assert.deepEqual(editorInvocation('subl', '/p/a.ts', 7), { command: 'subl', args: ['/p/a.ts:7'], terminal: false });
  });

  it('gives JetBrains editors --line', () => {
    assert.deepEqual(editorInvocation('idea', '/p/a.ts', 9), { command: 'idea', args: ['--line', '9', '/p/a.ts'], terminal: false });
    assert.deepEqual(editorInvocation('webstorm', '/p/a.ts'), { command: 'webstorm', args: ['/p/a.ts'], terminal: false });
  });

  it('marks terminal editors and passes +line', () => {
    assert.deepEqual(editorInvocation('nvim', '/p/a.ts', 4), { command: 'nvim', args: ['+4', '/p/a.ts'], terminal: true });
    assert.deepEqual(editorInvocation('vim', '/p/a.ts'), { command: 'vim', args: ['/p/a.ts'], terminal: true });
  });

  it('lets a configured command place the placeholders itself', () => {
    assert.deepEqual(
      editorInvocation('my-editor --open {file} --at {line}', '/p/a b.ts', 5),
      { command: 'my-editor', args: ['--open', '/p/a b.ts', '--at', '5'], terminal: false }
    );
    assert.deepEqual(
      editorInvocation('my-editor {file} {line}', '/p/a.ts'),
      { command: 'my-editor', args: ['/p/a.ts', ''], terminal: false }
    );
  });

  it('appends the file for an editor it does not know', () => {
    assert.deepEqual(editorInvocation('some-editor --flag', '/p/a.ts', 3), { command: 'some-editor', args: ['--flag', '/p/a.ts'], terminal: false });
    assert.throws(() => editorInvocation('   ', '/p/a.ts'), /No editor configured/);
  });

  it('quotes a terminal command line', () => {
    const line = shellLine({ command: 'nvim', args: ['+4', "/p/it's here.ts"], terminal: true });
    if (process.platform === 'win32') assert.match(line, /^"nvim"/);
    else assert.equal(line, `'nvim' '+4' '/p/it'\\''s here.ts'`);
  });
});

describe('finding an editor', () => {
  it('probes PATH for the known candidates', () => {
    const dir = tempDir();
    const bin = fakeEditor(dir, 'code');
    assert.equal(which('code', { PATH: dir }), bin);
    assert.equal(which('code', { PATH: '/nonexistent' }), null);
    assert.equal(which('', { PATH: dir }), null);
  });

  it('prefers the preference, then $EDITOR, then the candidate list', () => {
    const dir = tempDir();
    fakeEditor(dir, 'cursor');
    const env = { PATH: dir, EDITOR: 'cursor' };
    assert.equal(resolveEditor('code --wait', env), 'code --wait');
    assert.equal(resolveEditor('', env), 'cursor');
    assert.equal(resolveEditor('', { PATH: dir }), 'cursor', 'falls through to the candidate probe');
    assert.equal(resolveEditor('', { PATH: '/nonexistent' }), null);
  });

  it('ignores an $EDITOR that is not installed', () => {
    const dir = tempDir();
    fakeEditor(dir, 'zed');
    assert.equal(resolveEditor('', { PATH: dir, EDITOR: 'ghost-editor' }), 'zed');
  });
});

describe('opening a file', () => {
  it('refuses paths outside the project', async () => {
    const root = tempDir();
    const result = await openInEditor({ projectRoot: root, path: '../outside.ts' });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /escapes the project root/);
  });

  it('explains itself when no editor can be found', async () => {
    const root = tempDir();
    const saved = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      const result = await openInEditor({ projectRoot: root, path: 'a.ts' });
      assert.equal(result.ok, false);
      assert.match(result.error ?? '', /No editor found/);
    } finally {
      process.env.PATH = saved;
    }
  });

  it('launches the resolved editor with the file and line', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'a.ts'), 'text\n');
    const bin = tempDir();
    fakeEditor(bin, 'code');
    const out = path.join(tempDir(), 'args.txt');
    const savedPath = process.env.PATH;
    const savedOut = process.env.OUT;
    process.env.PATH = bin;
    process.env.OUT = out;
    try {
      const result = await openInEditor({ projectRoot: root, path: 'a.ts', line: 12 });
      assert.deepEqual(result, { ok: true, editor: 'code' });
      // The editor is spawned detached: wait for it to write its arguments.
      const deadline = Date.now() + 4000;
      while (!fs.existsSync(out) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25));
      assert.deepEqual(fs.readFileSync(out, 'utf8').trim().split('\n'), ['-g', path.join(root, 'a.ts') + ':12']);
    } finally {
      process.env.PATH = savedPath;
      if (savedOut === undefined) delete process.env.OUT;
      else process.env.OUT = savedOut;
    }
  });

  it('hands a terminal editor back as a command line instead of spawning it', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'a.ts'), 'text\n');
    const result = await openInEditor({ projectRoot: root, path: 'a.ts', line: 3, editor: 'nvim' });
    assert.equal(result.ok, true);
    assert.equal(result.editor, 'nvim');
    assert.equal(result.terminal?.cwd, path.resolve(root));
    assert.match(result.terminal?.command ?? '', /nvim/);
    assert.match(result.terminal?.command ?? '', /\+3/);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DesignPathError, collectFiles, editText, ensureWorkspace, listFiles, listVersions, promoteVariant, removePage,
  readText, resolveInside, restore, snapshot, workspaceRoot, writeText
} from '../../../../../main/design/workspace';
import { isDesignFileTool, runDesignFileTool } from '../../../../../main/design/tools';
import { DESIGN_TOOL_SPECS } from '$shared/design';

let sandbox = '';
let root = '';
let outside = '';

beforeEach(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'design-spec-')));
  root = ensureWorkspace(path.join(sandbox, 'designs', 'chat-1'));
  outside = path.join(sandbox, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.html'), '<p>secret</p>');
});
afterEach(() => { fs.rmSync(sandbox, { recursive: true, force: true }); });

describe('path jail', () => {
  it.each([
    ['dot-dot', '../outside/secret.html'],
    ['nested dot-dot', 'a/../../outside/secret.html'],
    ['backslash dot-dot', '..\\outside\\secret.html'],
    ['absolute posix', '/etc/passwd'],
    ['absolute elsewhere', '/var/tmp/outside/secret.html'],
    ['drive path', 'C:\\Windows\\win.ini'],
    ['home', '~/.ssh/id_rsa'],
    ['empty', '   '],
    ['versions folder', '.versions/0001/files/index.html']
  ])('rejects %s', (_label, rel) => {
    expect(() => resolveInside(root, rel)).toThrow(DesignPathError);
    expect(() => writeText(root, rel, 'x')).toThrow(DesignPathError);
  });

  it('rejects NUL bytes, even ones hiding a safe-looking suffix', () => {
    expect(() => resolveInside(root, 'index.html\0.png')).toThrow(/NUL/);
    expect(() => readText(root, '\0')).toThrow(DesignPathError);
    expect(() => resolveInside(root, 42)).toThrow(DesignPathError);
  });

  it('rejects a symlinked directory that points outside, for reads and for writes', () => {
    fs.symlinkSync(outside, path.join(root, 'escape'));
    expect(() => readText(root, 'escape/secret.html')).toThrow(/Symbolic links/);
    expect(() => writeText(root, 'escape/new.html', 'x')).toThrow(/Symbolic links/);
    expect(fs.existsSync(path.join(outside, 'new.html'))).toBe(false);
  });

  it('rejects a symlinked file that points outside', () => {
    fs.symlinkSync(path.join(outside, 'secret.html'), path.join(root, 'leak.html'));
    expect(() => readText(root, 'leak.html')).toThrow(DesignPathError);
    expect(() => writeText(root, 'leak.html', 'overwritten')).toThrow(DesignPathError);
    expect(fs.readFileSync(path.join(outside, 'secret.html'), 'utf8')).toBe('<p>secret</p>');
  });

  it('never lists or collects through a symlink', () => {
    fs.symlinkSync(outside, path.join(root, 'escape'));
    fs.symlinkSync(path.join(outside, 'secret.html'), path.join(root, 'leak.html'));
    writeText(root, 'index.html', '<p>hi</p>');
    expect(listFiles(root).map((file) => file.path)).toEqual(['index.html']);
    expect(Object.keys(collectFiles(root).files)).toEqual(['index.html']);
  });

  it('accepts ordinary nested paths, including backslash separators', () => {
    expect(resolveInside(root, 'variants/bold/index.html')).toBe(path.join(root, 'variants', 'bold', 'index.html'));
    expect(resolveInside(root, 'variants\\bold\\index.html')).toBe(path.join(root, 'variants', 'bold', 'index.html'));
    expect(resolveInside(root, './tokens.css')).toBe(path.join(root, 'tokens.css'));
  });

  it('only accepts opaque chat ids', () => {
    expect(workspaceRoot('/base', 'chat-abc_1')).toBe(path.join('/base', 'chat-abc_1'));
    for (const bad of ['../x', 'a/b', '', 'a\0b', 7, undefined]) expect(() => workspaceRoot('/base', bad)).toThrow(DesignPathError);
  });
});

describe('writes', () => {
  it('only writes text formats and caps their size', () => {
    expect(() => writeText(root, 'run.exe', 'x')).toThrow(/Only/);
    expect(() => writeText(root, 'photo.png', 'x')).toThrow(/Only/);
    expect(() => writeText(root, 'big.html', 'x'.repeat(600 * 1024))).toThrow(/too large/);
    expect(writeText(root, 'pages/pricing.html', '<h1>Pricing</h1>')).toBe('pages/pricing.html');
  });

  it('edits exactly one match, or says why not', () => {
    writeText(root, 'tokens.css', ':root{--a:1;--b:1}');
    expect(() => editText(root, 'tokens.css', '--zzz', 'x')).toThrow(/not found/);
    expect(() => editText(root, 'tokens.css', ':1', ':2')).toThrow(/matches 2 times/);
    expect(editText(root, 'tokens.css', ':1', ':2', true).replaced).toBe(2);
    expect(readText(root, 'tokens.css')).toBe(':root{--a:2;--b:2}');
  });
});

describe('the tool set', () => {
  it('has no shell, git, delete, network or image generation', () => {
    const names = DESIGN_TOOL_SPECS.map((spec) => spec.name).sort();
    expect(names).toEqual(['design_edit', 'design_inspect', 'design_list', 'design_motion', 'design_preview', 'design_read', 'design_snapshot', 'design_write']);
    expect(names.join(' ')).not.toMatch(/bash|shell|exec|git|delete|fetch|image|generate/);
  });

  it('refuses anything that is not a design file tool', () => {
    for (const name of ['bash', 'design_delete', 'read_file', 'design_preview', undefined]) {
      expect(isDesignFileTool(name)).toBe(false);
      expect(runDesignFileTool(root, name, { path: 'index.html' }).ok).toBe(false);
    }
  });

  it('reports a jail violation as a tool error, not a crash', () => {
    const result = runDesignFileTool(root, 'design_read', { path: '../outside/secret.html' });
    expect(result).toEqual({ ok: false, content: expect.stringContaining('leave the design workspace') });
    expect(runDesignFileTool(root, 'design_write', { path: '/tmp/pwn.html', content: 'x' }).ok).toBe(false);
  });

  it('writes, reads and lists through the tools', () => {
    expect(runDesignFileTool(root, 'design_list').content).toMatch(/empty/);
    const wrote = runDesignFileTool(root, 'design_write', { path: 'index.html', content: '<h1>Hi</h1>' });
    expect(wrote).toMatchObject({ ok: true, changed: ['index.html'] });
    expect(runDesignFileTool(root, 'design_read', { path: 'index.html' }).content).toBe('<h1>Hi</h1>');
    expect(runDesignFileTool(root, 'design_list').content).toBe('index.html (11 bytes)');
  });
});

describe('versions and variants', () => {
  it('snapshots only real changes and restores exactly', () => {
    expect(snapshot(root, 'empty')).toBeNull();
    writeText(root, 'index.html', 'one');
    expect(snapshot(root, 'first', true)).toMatchObject({ id: 1, label: 'first', auto: true, files: 1 });
    expect(snapshot(root, 'again')).toBeNull();
    writeText(root, 'index.html', 'two');
    writeText(root, 'extra/page.html', 'extra');
    expect(snapshot(root, 'second')?.id).toBe(2);

    const result = restore(root, 1);
    expect(result.restored).toBe(1);
    expect(readText(root, 'index.html')).toBe('one');
    expect(fs.existsSync(path.join(root, 'extra'))).toBe(false);
    // The state before a restore is itself a version, so a restore can be undone.
    expect(listVersions(root).map((version) => version.id)).toEqual([2, 1]);
    expect(() => restore(root, 99)).toThrow(/No version/);
  });

  it('keeps snapshots out of listings and out of reach of the tools', () => {
    writeText(root, 'index.html', 'one');
    snapshot(root, 'v');
    expect(listFiles(root).map((file) => file.path)).toEqual(['index.html']);
    expect(() => readText(root, '.versions/0001/files/index.html')).toThrow(DesignPathError);
  });

  it('promotes a variant over the design and rewrites its shared links', () => {
    writeText(root, 'index.html', 'old');
    writeText(root, 'tokens.css', ':root{}');
    writeText(root, 'variants/bold/index.html', '<link rel="stylesheet" href="../../tokens.css"><img src="../../assets/logo.svg">');
    const promoted = promoteVariant(root, 'bold');
    expect(readText(root, 'index.html')).toBe('<link rel="stylesheet" href="tokens.css"><img src="assets/logo.svg">');
    expect(promoted.before?.auto).toBe(true);
    expect(collectFiles(root).variants.map((variant) => variant.name)).toEqual(['bold']);
    expect(() => promoteVariant(root, '../bold')).toThrow(DesignPathError);
    expect(() => promoteVariant(root, 'missing')).toThrow(/no index.html/);
  });

  it('removes a page or a whole variant after saving a version, never the entry page', () => {
    writeText(root, 'index.html', 'home');
    writeText(root, 'pricing.html', 'prices');
    writeText(root, 'variants/bold/index.html', 'bold');
    writeText(root, 'variants/bold/extra.css', 'a{}');
    const page = removePage(root, 'pricing.html');
    expect(page.before?.auto).toBe(true);
    expect(page.paths).toEqual(['pricing.html']);
    removePage(root, 'variants/bold/index.html');
    expect(listFiles(root).map((file) => file.path)).toEqual(['index.html']);
    // Versions can bring both back.
    expect(listVersions(root).length).toBeGreaterThanOrEqual(2);
    expect(() => removePage(root, 'index.html')).toThrow(/entry page/);
    expect(() => removePage(root, '../outside/secret.html')).toThrow(DesignPathError);
    expect(() => removePage(root, 'tokens.css')).toThrow(DesignPathError);
    expect(() => removePage(root, 'variants/../index.html')).toThrow(DesignPathError);
    expect(() => removePage(root, 'gone.html')).toThrow(/does not exist/);
    expect(fs.existsSync(path.join(outside, 'secret.html'))).toBe(true);
  });
});

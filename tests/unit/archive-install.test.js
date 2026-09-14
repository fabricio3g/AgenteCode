import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';

import { ensureSafeEntryPath, extractArchive } from '../../main/archive-install.ts';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `archive-install-${prefix}-`));
}

describe('ensureSafeEntryPath', () => {
  it('accepts plain and nested relative entries', () => {
    assert.doesNotThrow(() => ensureSafeEntryPath('llama-server'));
    assert.doesNotThrow(() => ensureSafeEntryPath('bin/llama-server'));
    assert.doesNotThrow(() => ensureSafeEntryPath('lib./gpu-vendor.dll'));
    assert.doesNotThrow(() => ensureSafeEntryPath('a/b/../c'));
  });

  it('accepts the root entries real archives carry', () => {
    // tar/zip commonly include a './' root and 'dir/' directory entries;
    // rejecting these would abort extraction of legitimate releases.
    assert.doesNotThrow(() => ensureSafeEntryPath('.'));
    assert.doesNotThrow(() => ensureSafeEntryPath('./'));
    assert.doesNotThrow(() => ensureSafeEntryPath('./bin/llama-server'));
    assert.doesNotThrow(() => ensureSafeEntryPath('bin/'));
  });

  it('rejects traversal that escapes the destination', () => {
    assert.throws(() => ensureSafeEntryPath('../evil'), /Unsafe archive entry path/);
    assert.throws(() => ensureSafeEntryPath('../../evil'), /Unsafe archive entry path/);
    assert.throws(() => ensureSafeEntryPath('bin/../../../evil'), /Unsafe archive entry path/);
    assert.throws(() => ensureSafeEntryPath('..'), /Unsafe archive entry path/);
  });

  it('rejects absolute entries', () => {
    assert.throws(() => ensureSafeEntryPath('/etc/passwd'), /Unsafe archive entry path/);
    assert.throws(() => ensureSafeEntryPath('/bin/sh'), /Unsafe archive entry path/);
  });

  it('rejects empty entries', () => {
    assert.throws(() => ensureSafeEntryPath(''), /Unsafe archive entry path/);
    assert.throws(() => ensureSafeEntryPath(undefined), /Unsafe archive entry path/);
  });
});

describe('extractArchive', () => {
  it('unpacks a .tar.gz into the destination directory', async () => {
    const work = tempDir('extract');
    try {
      const payloadDir = path.join(work, 'payload');
      fs.mkdirSync(path.join(payloadDir, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(payloadDir, 'bin', 'runtime-bin'), '#!/bin/sh\n');

      const archivePath = path.join(work, 'runtime.tar.gz');
      await tar.c({ gzip: true, file: archivePath, cwd: payloadDir }, ['bin']);

      const destDir = path.join(work, 'dest');
      fs.mkdirSync(destDir, { recursive: true });
      await extractArchive('runtime.tar.gz', archivePath, destDir, 'runtime');

      assert.equal(fs.readFileSync(path.join(destDir, 'bin', 'runtime-bin'), 'utf8'), '#!/bin/sh\n');
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  it('labels the unsupported-format error with the caller kind', async () => {
    await assert.rejects(
      () => extractArchive('runtime.7z', '/tmp/none.tar', '/tmp/none', 'whisper runtime'),
      /Unsupported whisper runtime archive format: runtime\.7z/
    );
  });
});

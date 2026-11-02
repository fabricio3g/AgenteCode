import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import Database from '../../main/sqlite.ts';

import {
  closeDb,
  deleteFileRecord,
  fileStoreStats,
  getFileRecord,
  linkFileRef,
  listFileRecords,
  listFileRefs,
  setChatDbPath,
  setFilePinned,
  setFileStatus,
  unlinkFileRef,
  unlinkFileRefsForMessage,
  upsertFileRecord
} from '../../main/chat-db.ts';

const require = createRequire(import.meta.url);
const hashOf = (value) => createHash('sha256').update(value).digest('hex');

// Built-in SQLite works under both Node and Electron without addon rebuilding.
const sqliteUnavailable = (() => {
  try {
    new Database(':memory:').close();
    return '';
  } catch (error) {
    return String(error?.message || error || 'node:sqlite unavailable');
  }
})();

let dir;

before(() => {
  if (sqliteUnavailable) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-registry-'));
  // setChatDbPath takes the db file itself; the worker client resolves the
  // same name under cacheRoot.
  setChatDbPath(path.join(dir, 'chat-history.db'));
});

after(() => {
  closeDb();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function itWithSqlite(name, fn) {
  it(name, (t) => {
    if (sqliteUnavailable) {
      t.skip(`node:sqlite unavailable: ${sqliteUnavailable}`);
      return;
    }
    fn();
  });
}

describe('global file registry', () => {
  itWithSqlite('upserts by hash, refreshes identity fields and keeps what the store learned', () => {
    const hash = hashOf('quarterly.pdf');
    const first = upsertFileRecord({
      hash,
      name: 'quarterly.pdf',
      mime: 'application/pdf',
      bytes: 2048,
      kind: 'pdf',
      storedPath: '/store/quarterly.pdf',
      createdAt: 1000,
      lastUsedAt: 1000
    });

    assert.equal(first.hash, hash);
    assert.equal(first.pinned, false);
    assert.equal(first.origin, 'upload');
    assert.equal(first.extractStatus, 'pending');
    assert.equal(first.extractedChars, 0);
    assert.equal(first.ragDocId, null);
    assert.equal(first.specPath, null);
    assert.equal(first.version, 1);

    setFilePinned(hash, true);
    setFileStatus(hash, { extractStatus: 'ready', extractedChars: 4096, ragDocId: 'doc-quarterly' });

    // Same content again, renamed and re-pathed: one row, new identity, the
    // extraction state and the pin survive.
    const second = upsertFileRecord({
      hash,
      name: 'quarterly-2026.pdf',
      mime: 'application/pdf',
      bytes: 4096,
      kind: 'pdf',
      storedPath: '/store/quarterly-2026.pdf',
      lastUsedAt: 2000
    });

    assert.equal(listFileRecords().filter((file) => file.hash === hash).length, 1);
    assert.equal(second.name, 'quarterly-2026.pdf');
    assert.equal(second.bytes, 4096);
    assert.equal(second.storedPath, '/store/quarterly-2026.pdf');
    assert.equal(second.lastUsedAt, 2000);
    assert.equal(second.createdAt, 1000);
    assert.equal(second.pinned, true);
    assert.equal(second.extractStatus, 'ready');
    assert.equal(second.extractedChars, 4096);
    assert.equal(second.ragDocId, 'doc-quarterly');
    assert.equal(second.origin, 'upload');

    assert.equal(upsertFileRecord({ name: 'no hash' }), null);
  });

  itWithSqlite('links a ref once and bumps last_used_at', () => {
    const hash = hashOf('notes.md');
    upsertFileRecord({ hash, name: 'notes.md', kind: 'markdown', bytes: 64, createdAt: 1000, lastUsedAt: 1000 });

    const at = Date.now();
    assert.equal(linkFileRef({ hash, chatId: 'chat-a', messageId: 'msg-1' }), true);
    assert.equal(linkFileRef({ hash, chatId: 'chat-a', messageId: 'msg-1' }), false);
    assert.equal(listFileRefs(hash).length, 1);
    assert.deepEqual(listFileRefs(hash)[0], { hash, chatId: 'chat-a', messageId: 'msg-1' });
    assert.ok(getFileRecord(hash).lastUsedAt >= at, 'linking marks the file as used');

    assert.equal(unlinkFileRef({ hash, chatId: 'chat-a', messageId: 'msg-1' }), true);
    assert.equal(unlinkFileRef({ hash, chatId: 'chat-a', messageId: 'msg-1' }), false);
    assert.equal(listFileRefs(hash).length, 0);
  });

  itWithSqlite('lets two chats reference the same hash', () => {
    const hash = hashOf('spec.docx');
    upsertFileRecord({ hash, name: 'spec.docx', kind: 'docx', bytes: 512 });
    linkFileRef({ hash, chatId: 'chat-a', messageId: 'msg-1' });
    linkFileRef({ hash, chatId: 'chat-b', messageId: 'msg-2' });

    assert.deepEqual(
      listFileRefs(hash).map((ref) => [ref.chatId, ref.messageId]),
      [['chat-a', 'msg-1'], ['chat-b', 'msg-2']]
    );
  });

  itWithSqlite('unlinks only the refs of the message being replaced', () => {
    const hash = hashOf('replaced.txt');
    upsertFileRecord({ hash, name: 'replaced.txt', bytes: 32 });
    linkFileRef({ hash, chatId: 'chat-a', messageId: 'msg-replace-1' });
    linkFileRef({ hash, chatId: 'chat-a', messageId: 'msg-replace-2' });
    linkFileRef({ hash, chatId: 'chat-b', messageId: 'msg-replace-3' });

    assert.equal(unlinkFileRefsForMessage('msg-replace-1'), 1);
    assert.deepEqual(
      listFileRefs(hash).map((ref) => [ref.chatId, ref.messageId]),
      [['chat-a', 'msg-replace-2'], ['chat-b', 'msg-replace-3']]
    );
    assert.equal(unlinkFileRefsForMessage('msg-replace-1'), 0);
  });

  itWithSqlite('counts pinned and referenced files as used, the rest as unused', () => {
    const before = fileStoreStats();
    const pinned = hashOf('pinned.pdf');
    const referenced = hashOf('referenced.png');
    const orphan = hashOf('orphan.bin');
    upsertFileRecord({ hash: pinned, name: 'pinned.pdf', bytes: 1000 });
    upsertFileRecord({ hash: referenced, name: 'referenced.png', bytes: 2000 });
    upsertFileRecord({ hash: orphan, name: 'orphan.bin', bytes: 4000 });
    setFilePinned(pinned, true);
    linkFileRef({ hash: referenced, chatId: 'chat-a', messageId: 'msg-1' });

    const after = fileStoreStats();
    assert.equal(after.count - before.count, 3);
    assert.equal(after.bytes - before.bytes, 7000);
    assert.equal(after.unusedCount - before.unusedCount, 1, 'only the unreferenced, unpinned file is unused');
    assert.equal(after.unusedBytes - before.unusedBytes, 4000);
  });

  itWithSqlite('cascades a file\'s refs when the file is deleted', () => {
    const hash = hashOf('gone.xlsx');
    upsertFileRecord({ hash, name: 'gone.xlsx', kind: 'xlsx', bytes: 128 });
    linkFileRef({ hash, chatId: 'chat-a', messageId: 'msg-1' });
    linkFileRef({ hash, chatId: 'chat-b', messageId: 'msg-2' });

    assert.equal(deleteFileRecord(hash), true);
    assert.equal(getFileRecord(hash), null);
    assert.equal(listFileRefs(hash).length, 0);
    assert.equal(deleteFileRecord(hash), false);
  });

  itWithSqlite('round-trips extraction status and pinning', () => {
    const hash = hashOf('scan.pdf');
    upsertFileRecord({ hash, name: 'scan.pdf', kind: 'pdf', bytes: 900 });

    const extracting = setFileStatus(hash, { extractStatus: 'extracting' });
    assert.equal(extracting.extractStatus, 'extracting');
    assert.equal(extracting.extractedChars, 0);

    const ready = setFileStatus(hash, { extractStatus: 'ready', extractedChars: 12000, ragDocId: 'doc-scan' });
    assert.equal(ready.extractStatus, 'ready');
    assert.equal(ready.extractedChars, 12000);
    assert.equal(ready.ragDocId, 'doc-scan');

    // A partial update leaves the fields it does not mention alone.
    const degraded = setFileStatus(hash, { extractStatus: 'keyword-only' });
    assert.equal(degraded.extractStatus, 'keyword-only');
    assert.equal(degraded.extractedChars, 12000);
    assert.equal(degraded.ragDocId, 'doc-scan');

    const cleared = setFileStatus(hash, { ragDocId: null });
    assert.equal(cleared.ragDocId, null);
    assert.equal(cleared.extractStatus, 'keyword-only');

    assert.equal(setFilePinned(hash, true).pinned, true);
    assert.equal(getFileRecord(hash).pinned, true);
    assert.equal(setFilePinned(hash, false).pinned, false);
    assert.equal(setFileStatus('missing-hash', { extractStatus: 'ready' }), null);
    assert.equal(setFilePinned('missing-hash', true), null);
  });

  itWithSqlite('reopens the same file and re-runs migrate without losing rows', () => {
    const hash = hashOf('survives.txt');
    upsertFileRecord({ hash, name: 'survives.txt', kind: 'text', bytes: 24, origin: 'generated', specPath: '/specs/survives.json', version: 3 });
    linkFileRef({ hash, chatId: 'chat-a', messageId: 'msg-1' });

    closeDb();

    // getDb() migrates again on the existing file: CREATE TABLE IF NOT EXISTS
    // plus the addColumn helper must be a no-op and the rows must survive.
    const reopened = getFileRecord(hash);
    assert.equal(reopened.name, 'survives.txt');
    assert.equal(reopened.origin, 'generated');
    assert.equal(reopened.specPath, '/specs/survives.json');
    assert.equal(reopened.version, 3);
    assert.equal(listFileRefs(hash).length, 1);
    assert.equal(listFileRecords().filter((file) => file.hash === hash).length, 1);
  });
});

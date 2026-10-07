import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, before, describe, it } from 'node:test';

import { attachmentStoreDir } from '../../main/attachment-store.ts';

/**
 * Ingest, reuse and scope, against the real engine.
 *
 * The claim this file exists to hold up: attaching the same file to a second
 * chat reuses the indexed document — same id, same chunks, no second parse —
 * and a document survives in the chat that still holds it.
 */

const require = createRequire(import.meta.url);
const electronPath = require.resolve('electron');

let tempDir;
let documentPath;
let rag;
let chatDb;
let sqliteUnavailable = '';

function installElectronMock(root) {
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      app: {
        isPackaged: false,
        getPath(name) {
          if (name === 'home') return path.join(root, 'home');
          if (name === 'appData') return path.join(root, 'appData');
          if (name === 'exe') return path.join(root, 'app.exe');
          return path.join(root, name);
        }
      }
    }
  };
}

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-ingest-'));
  process.env.TALAMOLM_HOME = tempDir;
  installElectronMock(tempDir);

  documentPath = path.join(tempDir, 'quarterly-notes.md');
  fs.writeFileSync(documentPath, [
    '# Quarterly notes',
    '',
    '## Revenue',
    '',
    'Revenue rose twelve percent in the northern region while costs stayed flat.',
    '',
    '## Risks',
    '',
    'The southern region grew more slowly and shipped fewer units than planned.'
  ].join('\n'));

  try {
    const Database = require('better-sqlite3');
    const probe = new Database(':memory:');
    probe.close();
  } catch (error) {
    sqliteUnavailable = String(error?.message || error || 'better-sqlite3 unavailable');
  }

  rag = await import('../../main/rag-engine.ts');
  chatDb = await import('../../main/chat-db.ts');
});

after(() => {
  delete process.env.TALAMOLM_HOME;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('document ingest', () => {
  it('records the file in the registry and links it to the chat', async (t) => {
    if (sqliteUnavailable) { t.skip(`better-sqlite3 unavailable: ${sqliteUnavailable}`); return; }

    const doc = await rag.ingestDocument({ file_path: documentPath, chat_id: 'chat-a' });
    assert.ok(doc.id, 'the document has an id');
    assert.equal(doc.file_type, 'markdown');
    assert.equal(doc.source, 'quarterly-notes.md', 'cited by the name the user knows');

    const file = chatDb.getFileRecord(sha256(documentPath));
    assert.ok(file, 'the file is in the registry');
    assert.equal(file.name, 'quarterly-notes.md');
    assert.equal(file.kind, 'markdown');
    assert.equal(file.extractStatus, 'ready');
    assert.equal(file.ragDocId, doc.id);
    assert.ok(file.extractedChars > 0);

    // The copy lives in this app's store under its content hash, so it outlives
    // the composer's temp file and reveal/re-index have something to point at.
    assert.ok(file.storedPath.startsWith(attachmentStoreDir()), file.storedPath);
    assert.match(path.basename(file.storedPath), /^[0-9a-f]{12}\.md$/);
    assert.equal(fs.readFileSync(file.storedPath, 'utf8'), fs.readFileSync(documentPath, 'utf8'));

    const refs = chatDb.listFileRefs(file.hash);
    assert.deepEqual(refs.map((ref) => ref.chatId), ['chat-a']);
  });

  it('names the file after the upload, not after the temp copy', async (t) => {
    if (sqliteUnavailable) { t.skip(`better-sqlite3 unavailable: ${sqliteUnavailable}`); return; }

    // The composer writes `<timestamp>_<name>`; the timestamp is not part of the
    // file's name and used to end up in every citation. Its own content, so this
    // case never shares the document the other cases are about.
    const source = path.join(tempDir, 'naming-notes.md');
    fs.writeFileSync(source, '# Naming\n\nA file of its own, with words nothing else uses.\n');
    const temp = path.join(tempDir, `${Date.now()}_naming-notes.md`);
    fs.copyFileSync(source, temp);

    const doc = await rag.ingestDocument({ file_path: temp, chat_id: 'chat-named', name: 'naming-notes.md' });
    assert.equal(doc.source, 'naming-notes.md');
    assert.equal(chatDb.getFileRecord(sha256(temp)).name, 'naming-notes.md');

    const untitled = await rag.ingestDocument({ file_path: temp, chat_id: 'chat-named' });
    assert.equal(untitled.source, 'naming-notes.md', 'the prefix is stripped even without a name');
  });

  it('reuses the indexed document in a second chat', async (t) => {
    if (sqliteUnavailable) { t.skip(`better-sqlite3 unavailable: ${sqliteUnavailable}`); return; }

    const first = await rag.ingestDocument({ file_path: documentPath, chat_id: 'chat-a' });
    const second = await rag.ingestDocument({ file_path: documentPath, chat_id: 'chat-b' });

    assert.equal(second.reused, true, 'the second attach reuses the indexed document');
    assert.equal(second.id, first.id);
    assert.equal(chatDb.listFileRefs(sha256(documentPath)).length, 2, 'both chats reference the file');

    // Both chats can answer from it, and the shared chunks are not scored twice.
    const inSecond = await rag.queryDocuments({ query: 'southern region', chat_id: 'chat-b' });
    assert.equal(inSecond.retrieval, 'keyword');
    assert.match(inSecond.context, /quarterly-notes\.md/);
    assert.match(inSecond.context, /southern region/);
    assert.equal(new Set(inSecond.results.map((entry) => entry.chunk.id)).size, inSecond.results.length, 'no chunk is scored twice');
  });

  it('answers a library query from another chat and can filter by type', async (t) => {
    if (sqliteUnavailable) { t.skip(`better-sqlite3 unavailable: ${sqliteUnavailable}`); return; }

    const other = path.join(tempDir, 'unrelated.txt');
    fs.writeFileSync(other, 'A note about shipping schedules and warehouse capacity.');
    await rag.ingestDocument({ file_path: other, chat_id: 'chat-z' });

    const scoped = await rag.queryDocuments({ query: 'shipping schedules', chat_id: 'chat-a' });
    assert.ok(!scoped.context.includes('unrelated.txt'), 'another chat is out of scope by default');

    const library = await rag.queryDocuments({ query: 'shipping schedules', chat_id: 'chat-a', scope: 'library' });
    assert.ok(library.results.length > 0);
    assert.match(library.context, /unrelated\.txt/);

    const byType = await rag.queryDocuments({ query: 'revenue', chat_id: 'chat-a', scope: 'library', file_type: 'text' });
    assert.ok(byType.results.every((entry) => entry.document.file_type === 'text'));

    // A model names a file rather than its hash; both have to work.
    const byName = await rag.queryDocuments({ query: 'revenue', chat_id: 'chat-a', scope: 'library', files: ['quarterly-notes.md'] });
    assert.ok(byName.results.length > 0);
    assert.ok(byName.results.every((entry) => entry.document.source === 'quarterly-notes.md'));
    const byHash = await rag.queryDocuments({ query: 'revenue', chat_id: 'chat-a', scope: 'library', files: [sha256(documentPath)] });
    assert.ok(byHash.results.every((entry) => entry.document.source === 'quarterly-notes.md'));
  });

  it('keeps a shared document while a chat still holds it', async (t) => {
    if (sqliteUnavailable) { t.skip(`better-sqlite3 unavailable: ${sqliteUnavailable}`); return; }

    const doc = await rag.ingestDocument({ file_path: documentPath, chat_id: 'chat-a' });
    await rag.ingestDocument({ file_path: documentPath, chat_id: 'chat-b' });

    assert.equal(await rag.removeRagDocument(doc.id, 'chat-a'), true);
    const stillThere = await rag.queryDocuments({ query: 'northern region', chat_id: 'chat-b' });
    assert.ok(stillThere.results.length > 0, 'chat-b keeps the document');
    assert.equal(chatDb.getFileRecord(sha256(documentPath)).ragDocId, doc.id, 'the registry still points at it');

    assert.equal(await rag.removeRagDocument(doc.id, 'chat-b'), true);
    const gone = await rag.queryDocuments({ query: 'northern region', chat_id: 'chat-b' });
    assert.equal(gone.results.length, 0);
    assert.equal(chatDb.getFileRecord(sha256(documentPath)).ragDocId, null, 'a later attach indexes it again');
  });
});

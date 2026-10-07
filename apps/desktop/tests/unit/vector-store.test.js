import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import lancedb from '@lancedb/lancedb';

import { VectorStore } from '../../main/vector-store.ts';

/**
 * The store used to keep one LanceDB table per chat, which made a file's vectors
 * unusable anywhere else. These specs pin the shared layout: a chunk knows its
 * document and its chat, so re-attaching a file costs nothing and a library-wide
 * query is a wider filter instead of a fan-out over tables.
 */

let dir;
let store;
let db;

const chunk = (id, text) => ({ id, text, index: Number(id.split('-').pop()), heading: 'Page 1', line_start: 3, line_end: 4 });
const vector = (axis, size = 8) => Array.from({ length: size }, (_, i) => (i === axis ? 1 : 0));

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vector-store-'));
  db = await lancedb.connect(dir);
  store = new VectorStore();
  await store.init(dir);
});

after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('vector store', () => {
  it('searches only the documents in scope', async () => {
    await store.addChunks('chat-1', { id: 'doc-1', source: 'a.pdf', file_type: 'pdf' }, [chunk('doc-1-0', 'alpha'), chunk('doc-1-1', 'beta')], [vector(0), vector(1)]);
    await store.addChunks('chat-2', { id: 'doc-2', source: 'b.pdf', file_type: 'pdf' }, [chunk('doc-2-0', 'gamma')], [vector(2)]);

    const inScope = await store.search(['doc-1'], vector(1), 5);
    assert.deepEqual(inScope.map((row) => row.id), ['doc-1-1', 'doc-1-0']);

    const wider = await store.search(['doc-1', 'doc-2'], vector(2), 5);
    assert.equal(wider[0].id, 'doc-2-0');
    assert.equal(wider.length, 3);

    assert.deepEqual(await store.search([], vector(2), 5), []);
  });

  it('reuses a document already indexed for another chat', async () => {
    // Same file attached in a second chat: the vectors are already there, so the
    // ingest must be able to see that instead of embedding it again.
    assert.equal(await store.hasVectors('doc-1'), true);
    assert.equal(await store.hasVectors('doc-unknown'), false);

    await store.addChunks('chat-3', { id: 'doc-1', source: 'a.pdf', file_type: 'pdf' }, [], []);
    assert.equal(await store.countRows(), 3);
  });

  it('replaces a document instead of doubling its chunks', async () => {
    await store.addChunks('chat-1', { id: 'doc-1', source: 'a.pdf', file_type: 'pdf' }, [chunk('doc-1-0', 'alpha')], [vector(0)]);
    assert.equal(await store.countRows(), 2, 'the replaced chunk is gone');
    const rows = await store.search(['doc-1'], vector(0), 5);
    assert.deepEqual(rows.map((row) => row.id), ['doc-1-0']);
  });

  it('deletes a document without touching the others', async () => {
    await store.deleteDocument('doc-2');
    assert.equal(await store.countRows(), 1, 'only doc-2 rows go');

    await store.deleteDocument('doc-1');
    assert.deepEqual(await store.search(['doc-1'], vector(0), 5), []);
    assert.equal(await store.countRows(), 0);
  });

  it('refuses ids that would be spliced into a predicate', async () => {
    await assert.rejects(() => store.deleteDocument("doc-1' OR '1'='1"), /Invalid id/);
    await assert.rejects(() => store.search(["x' OR '1'='1"], vector(0), 5), /Invalid id/);
  });

  it('moves the old per-chat tables into the shared one', async () => {
    // The legacy name is a lossy transform of the chat id (a UUID's dashes became
    // underscores), which is why the migration needs the id list, not the names.
    await db.createTable('chat_legacy_id', [
      { id: 'legacy-0', vector: vector(3), text: 'delta', chunk_index: 0, doc_id: 'doc-legacy', source: 'old.pdf', file_type: 'pdf' }
    ], { mode: 'overwrite' });

    const migrated = await store.migrateLegacyTables(['legacy-id']);
    assert.equal(migrated, 1);
    assert.equal((await db.tableNames()).includes('chat_legacy_id'), false, 'legacy table is dropped');

    const rows = await store.search(['doc-legacy'], vector(3), 5);
    assert.deepEqual(rows.map((row) => row.id), ['legacy-0']);
  });
});

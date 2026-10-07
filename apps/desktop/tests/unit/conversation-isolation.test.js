import { describe, it } from 'node:test';
import assert from 'node:assert';
describe('conversation isolation guards', () => {
  it('rejects RAG operations without an explicit chat id', async () => {
    const rag = await import('../../main/rag-engine.ts');

    await assert.rejects(
      () => rag.ingestText({ source: 'note', text: 'hello', chat_id: '' }),
      /chat_id is required/i
    );
    await assert.rejects(
      () => rag.ingestDocument({ file_path: 'missing.txt', chat_id: '' }),
      /chat_id is required/i
    );
    await assert.rejects(
      () => rag.queryDocuments({ query: 'hello', chat_id: '', top_k: 1 }),
      /chat_id is required/i
    );
    await assert.rejects(
      () => rag.listRagDocuments(''),
      /chat_id is required/i
    );
    await assert.rejects(
      () => rag.clearRagDocuments(''),
      /chat_id is required/i
    );
  });

  it('keeps ids that cannot be escaped out of vector-store predicates', async () => {
    const { vectorStore } = await import('../../main/vector-store.ts');

    // Chunks live in one table now, so isolation comes from validated ids and a
    // `doc_id IN (…)` filter rather than from a table name per chat.
    await assert.rejects(() => vectorStore.deleteChat("chat' OR '1'='1"), /Invalid id/i);
    await assert.rejects(() => vectorStore.deleteDocument("doc' OR '1'='1"), /Invalid id/i);
    await assert.rejects(() => vectorStore.search(["doc' OR '1'='1"], [1, 0], 1), /Invalid id/i);
  });
});

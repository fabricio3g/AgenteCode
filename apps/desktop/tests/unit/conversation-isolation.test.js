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

  it('sanitizes vector-store table names per chat', async () => {
    const { vectorStore } = await import('../../main/vector-store.ts');

    assert.strictEqual(vectorStore._tableName('chat-123'), 'chat_chat_123');
    assert.strictEqual(vectorStore._tableName('chat:with/slashes'), 'chat_chat_with_slashes');
    assert.throws(() => vectorStore._tableName(''), /chatId is required/i);
  });
});

import lancedb from '@lancedb/lancedb';
import path from 'node:path';
import { getAppPaths } from './paths.ts';

class VectorStore {
  constructor() {
    this.db = null;
    this.tables = new Map();
    this.indexState = new Map();
  }

  async init() {
    const { cacheRoot } = getAppPaths();
    const dbPath = path.join(cacheRoot, 'lancedb');
    this.db = await lancedb.connect(dbPath);
  }

  _tableName(chatId) {
    const safeId = String(chatId || '')
      .trim()
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .replace(/^_+|_+$/g, '');
    if (!safeId) throw new Error('chatId is required for vector store isolation');
    return `chat_${safeId}`;
  }

  async getTable(chatId) {
    const tableName = this._tableName(chatId);
    if (this.tables.has(tableName)) {
      return this.tables.get(tableName);
    }
    try {
      const table = await this.db.openTable(tableName);
      this.tables.set(tableName, table);
      await this.ensureVectorIndex(tableName, table);
      return table;
    } catch {
      return null;
    }
  }

  async ensureVectorIndex(tableName, table) {
    if (!table) return;
    if (this.indexState.get(tableName) === true) return;
    if (this.indexState.get(tableName) === 'building') return;

    this.indexState.set(tableName, 'building');
    try {
      const indices = await table.listIndices().catch(() => []);
      const hasVectorIndex = Array.isArray(indices)
        && indices.some((idx) => Array.isArray(idx?.columns) && idx.columns.includes('vector'));
      if (!hasVectorIndex) {
        await table.createIndex('vector');
      }
      this.indexState.set(tableName, true);
    } catch (err: unknown) {
      console.warn('[RAG] Could not ensure vector index:', err instanceof Error ? err.message : String(err));
      this.indexState.set(tableName, false);
    }
  }

  async addChunks(chatId, docMetadata, chunks, embeddings) {
    const tableName = this._tableName(chatId);
    const records = chunks.map((chunk, i) => ({
      id: chunk.id,
      vector: Array.from(embeddings[i] || new Float32Array(0)),
      text: chunk.text,
      chunk_index: chunk.index,
      doc_id: docMetadata.id,
      source: docMetadata.source,
      file_type: docMetadata.file_type,
    }));

    if (records.length > 0 && records[0].vector.length > 0) {
      const table = await this.db.createTable(tableName, records, { mode: 'append' });
      this.tables.set(tableName, table);
      await this.ensureVectorIndex(tableName, table);
    }
  }

  async search(chatId, queryEmbedding, topK = 5) {
    const table = await this.getTable(chatId);
    if (!table) return [];
    return table.search(Array.from(queryEmbedding)).limit(topK).toArray();
  }

  async deleteChat(chatId) {
    const tableName = this._tableName(chatId);
    try { await this.db.dropTable(tableName); } catch {}
    this.tables.delete(tableName);
    this.indexState.delete(tableName);
  }

  async deleteDocument(chatId, docId) {
    const table = await this.getTable(chatId);
    if (!table) return false;
    await table.delete(`doc_id = '${docId}'`);
    return true;
  }

}

export const vectorStore = new VectorStore();

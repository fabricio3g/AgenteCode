import lancedb from '@lancedb/lancedb';
import path from 'node:path';
import { getAppPaths } from './index.js';

class VectorStore {
  constructor() {
    this.db = null;
    this.tables = new Map();
  }

  async init() {
    const { cacheRoot } = getAppPaths();
    const dbPath = path.join(cacheRoot, 'lancedb');
    this.db = await lancedb.connect(dbPath);
  }

  _tableName(chatId) {
    return `chat_${chatId.replace(/-/g, '_')}`;
  }

  async getTable(chatId) {
    const tableName = this._tableName(chatId);
    if (this.tables.has(tableName)) {
      return this.tables.get(tableName);
    }
    try {
      const table = await this.db.openTable(tableName);
      this.tables.set(tableName, table);
      return table;
    } catch {
      return null;
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
  }

  async deleteDocument(chatId, docId) {
    const table = await this.getTable(chatId);
    if (!table) return false;
    await table.delete(`doc_id = '${docId}'`);
    return true;
  }

  async listDocuments(chatId) {
    const table = await this.getTable(chatId);
    if (!table) return [];
    const rows = await table.query().select(['doc_id', 'source', 'file_type']).limit(10000).toArray();
    const docs = new Map();
    for (const row of rows) {
      if (!docs.has(row.doc_id)) {
        docs.set(row.doc_id, { id: row.doc_id, source: row.source, file_type: row.file_type, chunk_count: 0 });
      }
      docs.get(row.doc_id).chunk_count++;
    }
    return Array.from(docs.values());
  }
}

export const vectorStore = new VectorStore();

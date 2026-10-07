import lancedb from '@lancedb/lancedb';
import path from 'node:path';
import { getAppPaths } from './paths.ts';

/**
 * One LanceDB table for every document, not one per chat.
 *
 * A chunk row carries the document and the chat it belongs to, which is what
 * makes a file's embeddings reusable: attach the same file to a second chat and
 * the vectors are already there, no second embedding run. It is also what makes
 * the wider knowledge scopes possible — a query over the library is a filter with
 * more ids in it, not a fan-out over N tables.
 */

export const CHUNK_TABLE = 'agente_chunks';

type ChunkRow = {
  id: string;
  vector: number[];
  text: string;
  chunk_index: number;
  heading: string;
  line_start: number;
  line_end: number;
  doc_id: string;
  chat_id: string;
  source: string;
  file_type: string;
};

type DocMetadata = { id: string; source?: string; file_type?: string };
type StoredChunk = { id: string; text: string; index: number; heading?: string; line_start?: number; line_end?: number };

/** LanceDB predicates are SQL strings; ids are generated, so anything else is refused. */
function safeId(value: unknown): string {
  const id = String(value ?? '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid id for the vector store: ${value}`);
  return id;
}

function legacyTableName(chatId: unknown): string {
  const safe = String(chatId || '')
    .trim()
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!safe) throw new Error('chatId is required for vector store isolation');
  return `chat_${safe}`;
}

export class VectorStore {
  private db: ReturnType<typeof lancedb.connect> | null = null;
  private table: unknown = null;
  private indexState = false;

  /** `dir` is for tests; the app always uses `<cacheRoot>/lancedb`. */
  async init(dir?: string) {
    const dbPath = dir || path.join(getAppPaths().cacheRoot, 'lancedb');
    this.db = await lancedb.connect(dbPath);
    this.table = null;
    this.indexState = false;
    return this.db;
  }

  private async ensureTable() {
    if (this.table) return this.table as never;
    if (!this.db) throw new Error('Vector store not initialised');
    try {
      this.table = await (this.db as never as { openTable: (name: string) => Promise<unknown> }).openTable(CHUNK_TABLE);
    } catch {
      return null;
    }
    await this.ensureVectorIndex(this.table);
    return this.table as never;
  }

  private async ensureVectorIndex(table: unknown) {
    if (!table || this.indexState) return;
    this.indexState = true;
    try {
      const api = table as { listIndices: () => Promise<Array<{ columns?: string[] }>>; createIndex: (column: string) => Promise<unknown> };
      const indices = await api.listIndices().catch(() => []);
      if (!Array.isArray(indices) || !indices.some((index) => Array.isArray(index?.columns) && index.columns.includes('vector'))) {
        await api.createIndex('vector');
      }
    } catch (err: unknown) {
      // A missing vector index only costs speed; brute-force search still answers.
      this.indexState = false;
      console.warn('[RAG] Could not ensure vector index:', err instanceof Error ? err.message : String(err));
    }
  }

  /** Writes (or replaces) every chunk of one document. */
  async addChunks(chatId: string, docMetadata: DocMetadata, chunks: StoredChunk[], embeddings: number[][]) {
    const rows: ChunkRow[] = chunks.map((chunk, i) => ({
      id: String(chunk.id),
      vector: Array.from(embeddings[i] || []),
      text: chunk.text,
      chunk_index: chunk.index,
      heading: chunk.heading || '',
      line_start: chunk.line_start || 0,
      line_end: chunk.line_end || 0,
      doc_id: String(docMetadata.id),
      chat_id: String(chatId),
      source: String(docMetadata.source || ''),
      file_type: String(docMetadata.file_type || '')
    }));
    if (!rows.length || !rows[0].vector.length) return false;

    const table = await this.ensureTable();
    // Re-ingesting a document (a new version of the same file) replaces its rows
    // instead of doubling every result.
    if (table) {
      await (table as { delete: (predicate: string) => Promise<unknown>; add: (rows: ChunkRow[]) => Promise<unknown> }).delete(`doc_id = '${safeId(docMetadata.id)}'`);
      await (table as { add: (rows: ChunkRow[]) => Promise<unknown> }).add(rows);
      return true;
    }

    // `mode: 'append'` does not exist in @lancedb/lancedb 0.27 (only create and
    // overwrite) and threw on every ingest, so the semantic index was never
    // written. A new table is created here and grown with `add` from then on.
    const db = this.db as never as { createTable: (name: string, rows: ChunkRow[], options: { mode: string }) => Promise<unknown> };
    try {
      this.table = await db.createTable(CHUNK_TABLE, rows, { mode: 'create' });
    } catch {
      const raced = await this.ensureTable();
      if (!raced) throw new Error('Could not create the chunk table');
      await (raced as { add: (rows: ChunkRow[]) => Promise<unknown> }).add(rows);
    }
    await this.ensureVectorIndex(this.table);
    return true;
  }

  /** Nearest chunks among the given documents only. */
  async search(docIds: string[], queryEmbedding: number[], topK = 5) {
    const ids = [...new Set((docIds || []).map(safeId))];
    if (!ids.length) return [];
    const table = await this.ensureTable();
    if (!table) return [];
    const api = table as { search: (vector: number[]) => { where: (filter: string) => { limit: (n: number) => { toArray: () => Promise<Array<Record<string, unknown>>> } } } };
    return api
      .search(Array.from(queryEmbedding))
      .where(`doc_id IN (${ids.map((id) => `'${id}'`).join(', ')})`)
      .limit(topK)
      .toArray();
  }

  /** Does this document already have vectors? Lets an ingest skip re-embedding. */
  async hasVectors(docId: string): Promise<boolean> {
    const id = safeId(docId);
    const table = await this.ensureTable();
    if (!table) return false;
    const rows = await (table as { query: () => { where: (filter: string) => { limit: (n: number) => { toArray: () => Promise<unknown[]> } } } })
      .query()
      .where(`doc_id = '${id}'`)
      .limit(1)
      .toArray();
    return rows.length > 0;
  }

  async deleteDocument(docId: string): Promise<boolean> {
    const id = safeId(docId);
    const table = await this.ensureTable();
    if (!table) return false;
    await (table as { delete: (predicate: string) => Promise<unknown> }).delete(`doc_id = '${id}'`);
    return true;
  }

  /**
   * Everything a chat indexed. A document shared with another chat must be
   * deleted per document instead — the caller knows who still holds it.
   */
  async deleteChat(chatId: string): Promise<boolean> {
    const id = safeId(chatId);
    const table = await this.ensureTable();
    if (!table) return false;
    await (table as { delete: (predicate: string) => Promise<unknown> }).delete(`chat_id = '${id}'`);
    return true;
  }

  /**
   * Moves the old `chat_<id>` tables into the shared one. Called once with the
   * chat ids the app knows, because the old table name is a lossy transform of
   * the id and cannot be reversed.
   */
  async migrateLegacyTables(chatIds: string[]): Promise<number> {
    if (!this.db) return 0;
    const db = this.db as never as { tableNames: () => Promise<string[]>; openTable: (name: string) => Promise<unknown>; dropTable: (name: string) => Promise<unknown> };
    const names = await db.tableNames().catch(() => [] as string[]);
    let migrated = 0;

    for (const chatId of chatIds || []) {
      let name: string;
      try { name = legacyTableName(chatId); } catch { continue; }
      if (!names.includes(name)) continue;
      try {
        const legacy = await db.openTable(name);
        const rows = await (legacy as { query: () => { toArray: () => Promise<Array<Record<string, unknown>>> } }).query().toArray();
        const chunks = rows.map((row, index) => ({
          id: String(row.id ?? `${row.doc_id}_${index}`),
          text: String(row.text ?? ''),
          index: Number(row.chunk_index ?? index),
          heading: String(row.heading ?? ''),
          line_start: Number(row.line_start ?? 0),
          line_end: Number(row.line_end ?? 0)
        }));
        const embeddings = rows.map((row) => Array.from((row.vector as ArrayLike<number>) || []));
        const first = rows[0];
        if (chunks.length && first) {
          const byDoc = new Map<string, { chunks: StoredChunk[]; embeddings: number[][] }>();
          rows.forEach((row, index) => {
            const docId = String(row.doc_id ?? '');
            const entry = byDoc.get(docId) || { chunks: [], embeddings: [] };
            entry.chunks.push(chunks[index]);
            entry.embeddings.push(embeddings[index]);
            byDoc.set(docId, entry);
          });
          for (const [docId, entry] of byDoc) {
            await this.addChunks(chatId, {
              id: docId,
              source: String(first.source || ''),
              file_type: String(first.file_type || '')
            }, entry.chunks, entry.embeddings);
          }
        }
        await db.dropTable(name);
        migrated++;
      } catch (err: unknown) {
        console.warn(`[RAG] Could not migrate legacy vector table ${name}:`, err instanceof Error ? err.message : String(err));
      }
    }
    return migrated;
  }

  /** Test seam: how many chunk rows are stored. */
  async countRows(): Promise<number> {
    const table = await this.ensureTable();
    if (!table) return 0;
    return Number(await (table as { countRows: () => Promise<number> }).countRows()) || 0;
  }
}

export const vectorStore = new VectorStore();

import lancedb from '@lancedb/lancedb';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { getAppPaths } from './paths.ts';

/**
 * One LanceDB table per embedding model space (`agente_chunks` by default, or
 * `agente_chunks_<hash>` when a model id + dimension is supplied).
 *
 * A chunk row carries the document and the chat it belongs to, which is what
 * makes a file's embeddings reusable across chats while isolating different
 * embedding models so dimension or space changes never collide.
 */

const CHUNK_TABLE = 'agente_chunks';

export type VectorModelSpace = {
  modelId: string;
  dimension: number;
  version?: number;
};

export function tableNameForSpace(space?: VectorModelSpace | null): string {
  if (!space || (!space.dimension && space.modelId === 'default')) {
    return CHUNK_TABLE;
  }
  const digest = createHash('sha256')
    .update(`${space.modelId}:${space.dimension}:${space.version ?? 1}`)
    .digest('hex')
    .slice(0, 12);
  return `${CHUNK_TABLE}_${digest}`;
}

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
type EmbeddingLike = ArrayLike<number> | null | undefined;

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
  private tables = new Map<string, unknown>();
  private indexedTables = new Set<string>();
  private activeSpace: VectorModelSpace | null = null;

  setModelSpace(space: VectorModelSpace | null): void {
    this.activeSpace = space ? { ...space } : null;
  }

  getModelSpace(): VectorModelSpace | null {
    return this.activeSpace ? { ...this.activeSpace } : null;
  }

  private resolveTableName(space?: VectorModelSpace | null): string {
    return tableNameForSpace(space !== undefined ? space : this.activeSpace);
  }

  /** `dir` is for tests; the app always uses `<cacheRoot>/lancedb`. */
  async init(dir?: string) {
    const dbPath = dir || path.join(getAppPaths().cacheRoot, 'lancedb');
    this.db = await lancedb.connect(dbPath);
    this.tables.clear();
    this.indexedTables.clear();
    return this.db;
  }

  private async ensureTable(tableName = this.resolveTableName()) {
    if (this.tables.has(tableName)) return this.tables.get(tableName) as never;
    if (!this.db) throw new Error('Vector store not initialised');
    let table: unknown;
    try {
      table = await (this.db as never as { openTable: (name: string) => Promise<unknown> }).openTable(tableName);
    } catch {
      return null;
    }
    this.tables.set(tableName, table);
    await this.ensureVectorIndex(tableName, table);
    return table as never;
  }

  private async ensureVectorIndex(tableName: string, table: unknown) {
    if (!table || this.indexedTables.has(tableName)) return;
    this.indexedTables.add(tableName);
    try {
      const api = table as { listIndices: () => Promise<Array<{ columns?: string[] }>>; createIndex: (column: string) => Promise<unknown> };
      const indices = await api.listIndices().catch(() => []);
      if (!Array.isArray(indices) || !indices.some((index) => Array.isArray(index?.columns) && index.columns.includes('vector'))) {
        await api.createIndex('vector');
      }
    } catch (err: unknown) {
      // A missing vector index only costs speed; brute-force search still answers.
      this.indexedTables.delete(tableName);
      console.warn('[RAG] Could not ensure vector index:', err instanceof Error ? err.message : String(err));
    }
  }

  /** Writes (or replaces) every embedded chunk of one document. */
  async addChunks(
    chatId: string,
    docMetadata: DocMetadata,
    chunks: StoredChunk[],
    embeddings: EmbeddingLike[],
    space?: VectorModelSpace | null
  ) {
    const firstValid = embeddings.find((emb) => emb && emb.length > 0);
    const expectedDim = firstValid ? firstValid.length : 0;
    if (!expectedDim) return false;

    const rows: ChunkRow[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const emb = embeddings[i];
      if (!emb || emb.length !== expectedDim) continue;
      const chunk = chunks[i];
      rows.push({
        id: String(chunk.id),
        vector: Array.from(emb),
        text: chunk.text,
        chunk_index: chunk.index,
        heading: chunk.heading || '',
        line_start: chunk.line_start || 0,
        line_end: chunk.line_end || 0,
        doc_id: String(docMetadata.id),
        chat_id: String(chatId),
        source: String(docMetadata.source || ''),
        file_type: String(docMetadata.file_type || '')
      });
    }
    if (!rows.length) return false;

    const tableName = this.resolveTableName(space);
    const table = await this.ensureTable(tableName);
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
      const created = await db.createTable(tableName, rows, { mode: 'create' });
      this.tables.set(tableName, created);
      await this.ensureVectorIndex(tableName, created);
    } catch {
      const raced = await this.ensureTable(tableName);
      if (!raced) throw new Error('Could not create the chunk table');
      await (raced as { add: (rows: ChunkRow[]) => Promise<unknown> }).add(rows);
    }
    return true;
  }

  /** Nearest chunks among the given documents only. */
  async search(docIds: string[], queryEmbedding: ArrayLike<number>, topK = 5, space?: VectorModelSpace | null) {
    const ids = [...new Set((docIds || []).map(safeId))];
    if (!ids.length) return [];
    const table = await this.ensureTable(this.resolveTableName(space));
    if (!table) return [];
    const api = table as { search: (vector: number[]) => { where: (filter: string) => { limit: (n: number) => { toArray: () => Promise<Array<Record<string, unknown>>> } } } };
    return api
      .search(Array.from(queryEmbedding))
      .where(`doc_id IN (${ids.map((id) => `'${id}'`).join(', ')})`)
      .limit(topK)
      .toArray();
  }

  /** Does this document already have vectors? Lets an ingest skip re-embedding. */
  async hasVectors(docId: string, space?: VectorModelSpace | null): Promise<boolean> {
    const id = safeId(docId);
    const table = await this.ensureTable(this.resolveTableName(space));
    if (!table) return false;
    const rows = await (table as { query: () => { where: (filter: string) => { limit: (n: number) => { toArray: () => Promise<unknown[]> } } } })
      .query()
      .where(`doc_id = '${id}'`)
      .limit(1)
      .toArray();
    return rows.length > 0;
  }

  private async chunkTableNames(): Promise<string[]> {
    if (!this.db) return [];
    const db = this.db as never as { tableNames: () => Promise<string[]> };
    const names = await db.tableNames().catch(() => [] as string[]);
    return names.filter((name) => name === CHUNK_TABLE || name.startsWith(`${CHUNK_TABLE}_`));
  }

  async deleteDocument(docId: string): Promise<boolean> {
    const id = safeId(docId);
    const names = await this.chunkTableNames();
    let deleted = false;
    for (const name of names) {
      const table = await this.ensureTable(name);
      if (!table) continue;
      await (table as { delete: (predicate: string) => Promise<unknown> }).delete(`doc_id = '${id}'`);
      deleted = true;
    }
    return deleted;
  }

  /**
   * Everything a chat indexed. A document shared with another chat must be
   * deleted per document instead — the caller knows who still holds it.
   */
  async deleteChat(chatId: string): Promise<boolean> {
    const id = safeId(chatId);
    const names = await this.chunkTableNames();
    let deleted = false;
    for (const name of names) {
      const table = await this.ensureTable(name);
      if (!table) continue;
      await (table as { delete: (predicate: string) => Promise<unknown> }).delete(`chat_id = '${id}'`);
      deleted = true;
    }
    return deleted;
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
            }, entry.chunks, entry.embeddings, null);
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
  async countRows(space?: VectorModelSpace | null): Promise<number> {
    const table = await this.ensureTable(this.resolveTableName(space));
    if (!table) return 0;
    return Number(await (table as { countRows: () => Promise<number> }).countRows()) || 0;
  }
}

export const vectorStore = new VectorStore();

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getAppPaths } from './paths.ts';
import { getEmbedding, getEmbeddings } from './embedding-client.ts';
import { rerankChunks } from './reranker.ts';
import { vectorStore } from './vector-store.ts';
import { loadConfig } from './config.ts';
import { storeAttachmentFile } from './attachment-store.ts';
import { extractIngestionText, type IngestionText } from './document-ingestion.ts';
import type { DocumentIngestPayload } from '../shared/document-ingestion.ts';
import { ensureRagEmbeddingRuntime } from './rag/embedding-runtime.ts';
import { chunkMarkdown, searchableText } from './rag/chunking.ts';
import { Bm25, blendScores, buildContext, citationOf, selectDiverse, type Candidate } from './rag/ranking.ts';
import { chatDatabase } from './chat-db-client.ts';
import { createLogger } from './utils/logger.ts';
import { toErrorMessage } from '../shared/errors.ts';

const log = createLogger('[RAG]');

let vectorStoreReady = false;

async function ensureVectorStore(): Promise<void> {
  if (vectorStoreReady) return;
  try {
    await vectorStore.init();
    vectorStoreReady = true;
    // The store used to keep one table per chat. Its rows move into the shared
    // table once, keyed by the chat ids the JSON store knows: the old table name
    // is a lossy transform of the id and cannot be turned back into it.
    ensureStoreLoaded();
    const migrated = await vectorStore.migrateLegacyTables([...chatDocuments.keys()]).catch(() => 0);
    if (migrated) log.info(`Moved ${migrated} per-chat vector table(s) into ${'agente_chunks'}`);
  } catch (err: unknown) {
    log.warn('LanceDB init failed, falling back to JSON store:', toErrorMessage(err));
  }
}

type QueryCacheEntry = { embedding: number[]; expires: number };
type ChatDocStore = Map<string, { doc: Record<string, unknown>; chunks: Array<Record<string, unknown>> }>;

const chatDocuments = new Map<string, ChatDocStore>();
let storeLoaded = false;
let storeMtime = 0;
const queryEmbeddingCache = new Map<string, QueryCacheEntry>();
const QUERY_EMBEDDING_CACHE_TTL_MS = 2 * 60 * 1000;
const QUERY_EMBEDDING_CACHE_MAX = 200;
const SMALL_DATASET_FAST_PATH_CHUNKS = 200;
const DEFAULT_CHUNK_SIZE = 900;
/** Hard ceilings on what a query hands the model, whatever top_k asks for. */
const MAX_CONTEXT_CHARS = 120_000;
const MAX_CHUNK_CHARS = 4_000;

/** Registry kind by extension; the parser refines it once the text is out. */
const FILE_KINDS: Record<string, string> = {
  '.pdf': 'pdf', '.docx': 'docx', '.xlsx': 'xlsx', '.xlsm': 'xlsx', '.pptx': 'pptx',
  '.csv': 'csv', '.tsv': 'csv', '.html': 'html', '.htm': 'html',
  '.md': 'markdown', '.markdown': 'markdown', '.txt': 'text', '.json': 'json', '.jsonl': 'json'
};

/**
 * The name a file is shown under.
 *
 * The composer writes attachments to a temp file named `<timestamp>_<original>`,
 * so the timestamp is an implementation detail of the upload path, not part of
 * the file's name — citations used to read `1759801234567_report.pdf`.
 */
function displayName(filePath: string, given?: string): string {
  const name = String(given || '').trim() || path.basename(filePath);
  return name.replace(/^\d{10,}_/, '');
}

function kindForPath(filePath: string): string {
  return FILE_KINDS[path.extname(filePath).toLowerCase()] || 'file';
}

/** The loaded copy of a document, whichever chat first indexed it. */
function findStoredDocument(docId: string): { chatId: string; doc: Record<string, unknown>; chunks: Array<Record<string, unknown>> } | null {
  for (const [chatId, store] of chatDocuments) {
    const entry = store.get(docId);
    if (entry) return { chatId, doc: entry.doc, chunks: entry.chunks };
  }
  return null;
}

function getRagRuntimeSettings() {
  try {
    const config = loadConfig();
    const rag = config?.rag || {};
    return {
      rerank: rag.rerank === true
    };
  } catch {
    return { rerank: false };
  }
}

function queryEmbeddingCacheKey(query: string, chatId: string): string {
  return `${requireChatId(chatId)}:${String(query || '').trim().toLowerCase()}`;
}

function setQueryEmbeddingCache(key: string, embedding: number[] | null | undefined): void {
  if (!embedding) return;
  if (queryEmbeddingCache.size >= QUERY_EMBEDDING_CACHE_MAX) {
    const oldestKey = queryEmbeddingCache.keys().next().value;
    if (oldestKey) queryEmbeddingCache.delete(oldestKey);
  }
  queryEmbeddingCache.set(key, {
    embedding,
    expires: Date.now() + QUERY_EMBEDDING_CACHE_TTL_MS
  });
}

function getQueryEmbeddingCache(key: string): number[] | null {
  const cached = queryEmbeddingCache.get(key);
  if (!cached) return null;
  if (Date.now() > cached.expires) {
    queryEmbeddingCache.delete(key);
    return null;
  }
  queryEmbeddingCache.delete(key);
  queryEmbeddingCache.set(key, cached);
  return cached.embedding;
}

async function getCachedQueryEmbedding(query: string, chatId: string): Promise<number[] | null> {
  const key = queryEmbeddingCacheKey(query, chatId);
  const fromCache = getQueryEmbeddingCache(key);
  if (fromCache) return fromCache;
  const embedding = await getEmbedding(query);
  if (embedding) setQueryEmbeddingCache(key, embedding);
  return embedding;
}

async function indexRecordEmbeddings(chatId: string, record: { doc: Record<string, unknown>; chunks: Array<{ text: string; heading?: string }> }): Promise<void> {
  if (!record.chunks.some((chunk) => searchableText(chunk).trim())) return;
  // The heading trail is embedded with the text: "Page 3 › Results" is context the
  // chunk body alone does not carry. Order must match `record.chunks` for addChunks.
  const chunkTexts = record.chunks.map((chunk) => searchableText(chunk));

  await ensureRagEmbeddingRuntime().catch(() => {});

  const embeddings = await getEmbeddings(chunkTexts).catch(() => null);
  if (!embeddings) return;

  if (!vectorStoreReady) {
    await ensureVectorStore().catch(() => {});
  }
  if (!vectorStoreReady) return;

  try {
    await vectorStore.addChunks(chatId, record.doc, record.chunks, embeddings);
  } catch (err: unknown) {
    log.warn('LanceDB addChunks failed:', toErrorMessage(err));
  }
}

function getStorePath() {
  const { cacheRoot } = getAppPaths();
  return path.join(cacheRoot, 'rag-store-v2.json');
}

function requireChatId(chatId: string | unknown): string {
  const key = String(chatId || '').trim();
  if (!key) throw new Error('chat_id is required for RAG isolation');
  return key;
}

function ensureChatStore(chatId: string): ChatDocStore {
  const key = requireChatId(chatId);
  if (!chatDocuments.has(key)) {
    chatDocuments.set(key, new Map());
  }
  return chatDocuments.get(key)!;
}

function serializeStore(): { version: number; chats: unknown[] } {
  return {
    version: 2,
    chats: Array.from(chatDocuments.entries()).map(([chatId, docs]) => ({
      chatId,
      documents: Array.from(docs.entries()).map(([docId, entry]) => ({
        doc: entry.doc,
        chunks: entry.chunks
      }))
    }))
  };
}

function persistStore(): void {
  const storePath = getStorePath();
  const directory = path.dirname(storePath);
  const tmpPath = `${storePath}.${randomUUID()}.tmp`;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(serializeStore(), null, 2));
  fs.renameSync(tmpPath, storePath);
  try {
    storeMtime = fs.statSync(storePath).mtimeMs;
    storeLoaded = true;
  } catch {
    // ignore stat race
  }
}

function hydrateStore(raw: unknown): void {
  chatDocuments.clear();
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { chats?: unknown[] }).chats)) return;

  for (const chatEntry of (raw as { chats?: unknown[] }).chats || []) {
    const entry = chatEntry as { chatId?: string; documents?: Array<{ doc?: Record<string, unknown>; chunks?: unknown[] }> };
    const chatId = String(entry?.chatId || 'default');
    const docs = new Map<string, { doc: Record<string, unknown>; chunks: Array<Record<string, unknown>> }>();
    for (const docEntry of Array.isArray(entry?.documents) ? entry.documents : []) {
      const doc = docEntry?.doc;
      if (!doc?.id) continue;
      docs.set(String(doc.id), {
        doc: {
          ...doc,
          id: String(doc.id),
          source: String(doc.source || 'unknown'),
          file_type: String(doc.file_type || 'text'),
          chunk_count: Number(doc.chunk_count || 0),
          char_count: Number(doc.char_count || 0),
          created_at: Number(doc.created_at || doc.updated_at || Date.now()),
          updated_at: Number(doc.updated_at || doc.created_at || Date.now()),
          fingerprint: String(doc.fingerprint || '')
        },
        chunks: Array.isArray(docEntry?.chunks)
          ? docEntry.chunks.map((chunk: unknown, index: number) => {
              const c = chunk as { id?: string; doc_id?: string; text?: string; index?: number; heading?: string; line_start?: number; line_end?: number };
              return {
                id: String(c.id || `${doc.id}_${index}`),
                doc_id: String(c.doc_id || doc.id),
                text: String(c.text || ''),
                index: Number.isFinite(c.index) ? Number(c.index) : index,
                // Chunks indexed before citations existed carry none of these.
                heading: String(c.heading || ''),
                line_start: Number(c.line_start) || 0,
                line_end: Number(c.line_end) || 0
              };
            })
          : []
      });
    }
    chatDocuments.set(chatId, docs);
  }
}

function ensureStoreLoaded(): void {
  const storePath = getStorePath();
  if (fs.existsSync(storePath)) {
    try {
      const stat = fs.statSync(storePath);
      if (storeLoaded && stat.mtimeMs === storeMtime) return;
      const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      hydrateStore(raw);
      storeMtime = stat.mtimeMs;
      storeLoaded = true;
      return;
    } catch (err: unknown) {
      log.warn('Failed to load persisted store, starting fresh:', toErrorMessage(err));
      chatDocuments.clear();
    }
  }
  storeLoaded = true;
}

/**
 * Reads a file as Markdown for indexing.
 *
 * This used to handle only .pdf and .docx and fall through to
 * `readFileSync(path, 'utf8')` for everything else — so a .xlsx or .pptx was
 * indexed as decoded binary. Conversion now lives in `document-markdown.ts`,
 * which refuses formats it cannot actually read instead of guessing.
 */
async function extractText(filePath: string, supplied: DocumentIngestPayload): Promise<IngestionText> {
  try {
    return await extractIngestionText(filePath, supplied);
  } catch (err: unknown) {
    if (path.extname(filePath).toLowerCase() === '.pdf') {
      throw new Error(`Could not parse PDF text: ${toErrorMessage(err)}`);
    }
    throw err;
  }
}

function makeDocumentFingerprint(source: string, text: string, fileType: string): string {
  return createHash('sha1')
    .update(`${source || 'unknown'}\n${fileType || 'text'}\n${text || ''}`)
    .digest('hex');
}

function buildDocumentRecord({ source, text, chat_id, file_type, chunk_size }: { source: string; text: string; chat_id: string; file_type: string; chunk_size?: number }): { doc: Record<string, unknown>; chunks: Array<Record<string, unknown>> } {
  const chatId = requireChatId(chat_id);
  const normalizedText = String(text || '').trim();
  if (!normalizedText) throw new Error('No readable content to index.');
  const chunks = chunkMarkdown(normalizedText, { size: chunk_size || DEFAULT_CHUNK_SIZE });
  const docId = randomUUID();
  const fingerprint = makeDocumentFingerprint(source, normalizedText, file_type);
  const now = Date.now();

  return {
    doc: {
      id: docId,
      source: source || 'unknown',
      file_type: file_type || 'text',
      chunk_count: chunks.length,
      char_count: normalizedText.length,
      created_at: now,
      updated_at: now,
      fingerprint,
      chat_id: chatId
    },
    chunks: chunks.map((chunk, index) => ({
      id: `${docId}_${index}`,
      doc_id: docId,
      text: chunk.text,
      index,
      heading: chunk.heading,
      line_start: chunk.lineStart,
      line_end: chunk.lineEnd
    }))
  };
}

async function ingestTextInternal({ source, text, chat_id, file_type, chunk_size, background = false }: { source: string; text: string; chat_id: string; file_type: string; chunk_size?: number; background?: boolean }): Promise<Record<string, unknown>> {
  ensureStoreLoaded();
  const chatId = requireChatId(chat_id);
  const store = ensureChatStore(chatId);
  const record = buildDocumentRecord({ source, text, chat_id: chatId, file_type, chunk_size });

  // The same file (same name, type and text) dropped into the chat again is the
  // document already indexed — inserting it twice doubled its chunks in every result.
  for (const existing of store.values()) {
    if (existing.doc.fingerprint && existing.doc.fingerprint === record.doc.fingerprint) {
      return { ...existing.doc, deduplicated: true };
    }
  }

  store.set(record.doc.id as string, record);
  persistStore();

  // Save metadata to SQLite
  try {
    await chatDatabase.request('saveRagDocument', record.doc);
  } catch (err: unknown) {
    log.warn('Failed to save doc metadata to SQLite:', toErrorMessage(err));
  }

  const indexTask = indexRecordEmbeddings(chatId, record);
  if (background) {
    void indexTask.catch((err: unknown) => {
      log.warn('Background indexing failed:', toErrorMessage(err));
    });
  } else {
    await indexTask;
  }

  return record.doc;
}

export async function ingestDocument(payload: DocumentIngestPayload): Promise<Record<string, unknown>> {
  const { file_path, chat_id, message_id, name, chunk_size } = payload;
  const chatId = requireChatId(chat_id);
  const fileName = displayName(file_path, name);
  // Kept in this app's content-addressed store, so the file outlives the temp
  // copy the composer wrote and reveal/re-index still have something to point at.
  const { hash, storedPath, bytes } = storeAttachmentFile(file_path);

  // Already indexed somewhere on this machine: reuse the parsed chunks, and the
  // vectors too when the first ingest got that far. Re-parsing a 200-page PDF
  // because it was attached in a second chat is the cost this avoids.
  const known = await chatDatabase.request<{ ragDocId?: string | null; kind?: string } | null>('getFileRecord', hash).catch(() => null);
  if (known?.ragDocId) {
    const reused = await adoptStoredDocument(String(known.ragDocId), chatId);
    if (reused) {
      await chatDatabase.request('upsertFileRecord', { hash, name: fileName, bytes, kind: known.kind, storedPath });
      await chatDatabase.request('linkFileRef', { hash, chatId, messageId: message_id || '' });
      return { ...reused, hash, stored_path: storedPath };
    }
  }

  let extracted: IngestionText;
  try {
    extracted = await extractText(storedPath, payload);
  } catch (err: unknown) {
    await chatDatabase.request('upsertFileRecord', {
      hash, name: fileName, bytes, kind: kindForPath(file_path),
      storedPath, extractStatus: 'failed'
    }).catch(() => {});
    throw err;
  }

  await chatDatabase.request('upsertFileRecord', {
    hash, name: fileName, bytes, kind: extracted.fileType || kindForPath(file_path),
    storedPath
  });

  const doc = await ingestTextInternal({
    source: fileName,
    text: extracted.text,
    chat_id: chatId,
    file_type: extracted.fileType,
    chunk_size
  });

  // Persist provenance beside the chunks so reuse, library queries and later
  // turns retain the same extraction method and limitations.
  Object.assign(doc, { extraction_method: extracted.method, extraction_warning: extracted.warning });
  const extractionDir = path.join(getAppPaths().cacheRoot, 'ingestion');
  fs.mkdirSync(extractionDir, { recursive: true });
  const extractionPath = path.join(extractionDir, `${hash}.md`);
  const extractionTemp = `${extractionPath}.${randomUUID()}.tmp`;
  fs.writeFileSync(extractionTemp, extracted.text, 'utf8');
  fs.renameSync(extractionTemp, extractionPath);
  Object.assign(doc, { attachment_hash: hash });
  const indexed = ensureChatStore(chatId).get(String(doc.id));
  if (indexed) Object.assign(indexed.doc, doc);
  persistStore();

  await chatDatabase.request('setFileStatus', hash, {
    extractStatus: 'ready',
    extractedChars: extracted.text.length,
    ragDocId: String(doc.id)
  });
  await chatDatabase.request('linkFileRef', { hash, chatId, messageId: message_id || '' });
  return { ...doc, hash, stored_path: storedPath };
}

/**
 * Points a second chat at a document that is already indexed, and embeds it only
 * if the first ingest never got vectors (the embedding model was not running).
 * The vectors are stored per document, so one copy serves every chat.
 */
async function adoptStoredDocument(docId: string, chatId: string): Promise<Record<string, unknown> | null> {
  ensureStoreLoaded();
  const found = findStoredDocument(docId);
  if (!found) return null;

  const store = ensureChatStore(chatId);
  if (!store.has(docId)) {
    store.set(docId, { doc: { ...found.doc, chat_id: chatId }, chunks: found.chunks });
    persistStore();
  }

  if (vectorStoreReady) {
    const hasVectors = await vectorStore.hasVectors(docId).catch(() => true);
    if (!hasVectors) {
      const indexable = found.chunks.filter((chunk) => searchableText(chunk as { text: string; heading?: string }).trim()) as Array<{ id: string; text: string; index: number; heading?: string; line_start?: number; line_end?: number }>;
      const embeddings = await getEmbeddings(indexable.map((chunk) => searchableText(chunk))).catch(() => null);
      if (embeddings) {
        await vectorStore.addChunks(chatId, found.doc, indexable, embeddings).catch((err: unknown) => {
          log.warn('Re-embedding a shared document failed:', toErrorMessage(err));
        });
      }
    }
  }

  return { ...found.doc, chat_id: chatId, reused: true };
}

export async function ingestText({ source, text, chat_id, file_type, chunk_size }: { source: string; text: string; chat_id: string; file_type: string; chunk_size?: number }): Promise<Record<string, unknown>> {
  requireChatId(chat_id);
  return ingestTextInternal({ source, text, chat_id, file_type, chunk_size });
}

export async function ingestTextFast({ source, text, chat_id, file_type, chunk_size }: { source: string; text: string; chat_id: string; file_type: string; chunk_size?: number }): Promise<Record<string, unknown>> {
  requireChatId(chat_id);
  return ingestTextInternal({ source, text, chat_id, file_type, chunk_size, background: true });
}

export async function queryDocuments({ query, chat_id, top_k, scope, files, file_type }: { query: string; chat_id: string; top_k?: number; scope?: string; files?: string[]; file_type?: string }): Promise<Record<string, unknown>> {
  requireChatId(chat_id);
  return queryDocumentsHybrid({ query, chat_id, top_k, scope, files, file_type });
}

type StoredChunk = { id: string; doc_id: string; text: string; index: number; heading?: string; line_start?: number; line_end?: number };
type ChunkHit = { chunk: StoredChunk; doc: Record<string, unknown> };

async function queryDocumentsHybrid({ query, chat_id, top_k, scope, files, file_type }: { query: string; chat_id: string; top_k?: number; scope?: string; files?: string[]; file_type?: string }): Promise<Record<string, unknown>> {
  const chatId = requireChatId(chat_id);
  await ensureVectorStore().catch(() => {});
  await ensureRagEmbeddingRuntime().catch(() => {});
  ensureStoreLoaded();
  const settings = getRagRuntimeSettings();
  const k = Math.max(1, Number(top_k) || 5);

  // `chat` is this conversation's files plus anything pinned to the project;
  // `library` is every file indexed on this machine. A pinned file is one the
  // user marked as shared knowledge, so it answers in every chat.
  const libraryScope = String(scope || '').toLowerCase() === 'library';
  const pinnedDocIds = new Set<string>();
  try {
    const records = await chatDatabase.request<Array<{ hash?: string; name?: string; pinned?: boolean; ragDocId?: string | null }>>('listFileRecords');
    for (const file of records) {
      if (file.pinned && file.ragDocId) pinnedDocIds.add(String(file.ragDocId));
    }
  } catch {
    // The registry is an optimisation here; without it the chat scope still works.
  }
  // `files` comes from a model, so it accepts a file name as readily as a hash.
  const wanted = Array.isArray(files) ? files.map((entry) => String(entry)).filter(Boolean) : [];
  let wantedDocIds: Set<string> | null = null;
  if (wanted.length) {
    wantedDocIds = new Set<string>();
    try {
      const records = await chatDatabase.request<Array<{ hash?: string; name?: string; ragDocId?: string | null }>>('listFileRecords');
      const byHash = new Map(records.map((file) => [String(file.hash), file]));
      const byName = new Map(records.map((file) => [String(file.name).toLowerCase(), file]));
      for (const entry of wanted) {
        const file = byHash.get(entry) || byName.get(entry.toLowerCase());
        if (file?.ragDocId) wantedDocIds.add(String(file.ragDocId));
      }
    } catch {
      // Without the registry a name filter cannot be resolved; the other
      // filters and the scope still apply.
    }
  }
  const wantedType = file_type ? String(file_type) : '';

  const hits: ChunkHit[] = [];
  const seenChunks = new Set<string>();
  for (const [docChatId, store] of chatDocuments) {
    for (const { doc, chunks } of store.values()) {
      const docId = String(doc.id);
      if (wantedDocIds && !wantedDocIds.has(docId)) continue;
      if (wantedType && String(doc.file_type || '') !== wantedType) continue;
      if (!libraryScope && docChatId !== chatId && !pinnedDocIds.has(docId)) continue;
      for (const chunk of chunks) {
        // A document adopted by a second chat keeps the same chunk ids; without
        // this it would be scored twice and crowd out other sources.
        const chunkId = String((chunk as { id?: string }).id || '');
        if (chunkId) {
          if (seenChunks.has(chunkId)) continue;
          seenChunks.add(chunkId);
        }
        hits.push({ chunk: chunk as unknown as StoredChunk, doc });
      }
    }
  }
  if (!hits.length) {
    return { results: [], context: '', retrieval: 'none' };
  }

  // Keyword evidence for every chunk; BM25 over a few thousand chunks is cheap.
  const keyword = new Bm25(hits.map((hit) => `${hit.doc.source}\n${searchableText(hit.chunk)}`)).scores(query);

  // Vector evidence only past the small-dataset fast path, and only if the
  // embedding model actually answered — otherwise say so instead of degrading quietly.
  const vectorById = new Map<string, number>();
  let retrieval: 'hybrid' | 'keyword' = 'keyword';
  let notice: string | undefined;
  if (hits.length > SMALL_DATASET_FAST_PATH_CHUNKS) {
    const queryEmbedding = await getCachedQueryEmbedding(query, chatId);
    if (vectorStoreReady && queryEmbedding) {
      try {
        const docIds = [...new Set(hits.map((hit) => String(hit.chunk.doc_id)))];
        const rows = await vectorStore.search(docIds, queryEmbedding, Math.max(k * 4, 20));
        for (const row of rows) vectorById.set(String(row.id), row._distance != null ? Math.max(0, 1 - row._distance) : 0);
        retrieval = 'hybrid';
      } catch (err: unknown) {
        log.warn('LanceDB search failed, using keyword scoring:', toErrorMessage(err));
      }
    }
    if (retrieval === 'keyword') {
      notice = 'Semantic search unavailable (embedding model not installed or not running); results are keyword matches only.';
    }
  }

  const candidates: Candidate<ChunkHit>[] = hits.map((hit, i) => ({
    item: hit,
    docId: String(hit.chunk.doc_id),
    text: hit.chunk.text,
    keyword: keyword[i],
    vector: retrieval === 'hybrid' ? (vectorById.get(hit.chunk.id) ?? 0) : null,
    score: 0
  }));
  blendScores(candidates);
  candidates.sort((a, b) => b.score - a.score);

  let ranked = candidates;
  if (settings.rerank) {
    const top = candidates.slice(0, Math.min(Math.max(k * 2, 6), candidates.length)).filter((c) => c.score > 0);
    if (top.length > 1) {
      try {
        const reranked = await rerankChunks(query, top.map((c) => ({ text: c.text })), Math.min(k, top.length));
        if (reranked.length > 0 && reranked[0].rerankScore != null) {
          const byText = new Map(reranked.map((r: { text: string; rerankScore: number }) => [r.text, r.rerankScore]));
          for (const c of top) if (byText.has(c.text)) c.score = 1 + 1 / (1 + Math.exp(-byText.get(c.text)!));
          ranked = [...top.sort((a, b) => b.score - a.score), ...candidates.slice(top.length)];
        }
      } catch {
        // Reranker unavailable; keep the blended order.
      }
    }
  }

  let selected = selectDiverse(ranked, k);
  // Nothing matched ("summarize this"): hand back the opening of each document
  // rather than an empty answer.
  if (!selected.length) {
    selected = candidates
      .filter((c) => c.item.chunk.index < 2)
      .sort((a, b) => a.item.chunk.index - b.item.chunk.index)
      .slice(0, k);
  }

  const cited = selected.map((c) => ({
    source: String(c.item.doc.source || 'Document'),
    heading: c.item.chunk.heading || undefined,
    lineStart: c.item.chunk.line_start || undefined,
    lineEnd: c.item.chunk.line_end || undefined,
    text: c.item.chunk.text,
    warning: c.item.doc.extraction_warning ? String(c.item.doc.extraction_warning) : undefined
  }));
  const { context, included } = buildContext(cited, { maxChars: MAX_CONTEXT_CHARS, maxChunkChars: MAX_CHUNK_CHARS });

  return {
    results: selected.slice(0, included).map((c, i) => ({
      ref: i + 1,
      chunk: c.item.chunk,
      score: c.score,
      document: c.item.doc,
      citation: citationOf(cited[i])
    })),
    context,
    retrieval,
    ...(notice ? { notice } : {})
  };
}

export async function listRagDocuments(chatId: string): Promise<Record<string, unknown>[]> {
  const key = requireChatId(chatId);
  ensureStoreLoaded();
  const store = ensureChatStore(key);
  return Array.from(store.values()).map((entry) => entry.doc);
}

/** Read the canonical extraction, scoped to a chat holding this document. */
export function readIngestedDocument({ chat_id, doc_id }: { chat_id: string; doc_id: string }): { text: string; source: string; file_type: string; warning?: string } {
  const chatId = requireChatId(chat_id);
  ensureStoreLoaded();
  const found = ensureChatStore(chatId).get(doc_id);
  if (!found) throw new Error('This document is not attached to the chat.');
  const hash = String(found.doc.attachment_hash || '');
  const cachePath = /^[a-f0-9]{64}$/.test(hash) ? path.join(getAppPaths().cacheRoot, 'ingestion', `${hash}.md`) : '';
  // Older documents lack a canonical cache. Their indexed chunks still work.
  const text = cachePath && fs.existsSync(cachePath) ? fs.readFileSync(cachePath, 'utf8')
    : found.chunks.map((chunk) => `${chunk.heading ? `## ${chunk.heading}\n\n` : ''}${chunk.text}`).join('\n\n');
  return { text, source: String(found.doc.source || 'Document'), file_type: String(found.doc.file_type || 'text'),
    warning: found.doc.extraction_warning ? String(found.doc.extraction_warning) : undefined };
}

export async function removeRagDocument(docId: string, chatId: string): Promise<boolean> {
  const key = requireChatId(chatId);
  ensureStoreLoaded();
  const store = ensureChatStore(key);
  const removed = store.delete(docId);
  if (removed) {
    persistStore();
    // The same file can be attached to several chats, and its chunks and vectors
    // are shared. They only go when the last chat lets go of the document.
    const stillHeld = [...chatDocuments].some(([otherChat, otherStore]) => otherChat !== key && otherStore.has(docId));
    if (!stillHeld) {
      if (vectorStoreReady) {
        try { await vectorStore.deleteDocument(docId); } catch {}
      }
      // Let a later attach of the same file index it from scratch.
      try {
        const file = await chatDatabase.request<{ hash: string } | null>('getFileRecordByDocId', docId);
        if (file) await chatDatabase.request('setFileStatus', file.hash, { ragDocId: null });
      } catch {}
      try { await chatDatabase.request('deleteRagDocumentDb', docId); } catch {}
    }
  }
  return removed;
}

export async function clearRagDocuments(chatId: string): Promise<boolean> {
  const key = requireChatId(chatId);
  ensureStoreLoaded();
  const ownDocIds = [...(chatDocuments.get(key)?.keys() || [])];
  const removed = chatDocuments.delete(key);
  if (removed) {
    persistStore();
    const stillHeld = new Set<string>();
    for (const [otherChat, otherStore] of chatDocuments) {
      if (otherChat === key) continue;
      for (const docId of otherStore.keys()) stillHeld.add(docId);
    }
    for (const docId of ownDocIds) {
      if (stillHeld.has(docId)) continue;
      if (vectorStoreReady) {
        try { await vectorStore.deleteDocument(docId); } catch {}
      }
      try {
        const file = await chatDatabase.request<{ hash: string } | null>('getFileRecordByDocId', docId);
        if (file) await chatDatabase.request('setFileStatus', file.hash, { ragDocId: null });
      } catch {}
      try { await chatDatabase.request('deleteRagDocumentDb', docId); } catch {}
    }
    try { await chatDatabase.request('deleteRagDocumentsByChat', key); } catch {}
  }
  return removed;
}

export async function hasRagDocuments(chatId: string): Promise<boolean> {
  const key = requireChatId(chatId);
  ensureStoreLoaded();
  const store = chatDocuments.get(key);
  return !!store && store.size > 0;
}

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getAppPaths } from './paths.ts';
import { getEmbedding, getEmbeddings } from './embedding-client.ts';
import { rerankChunks } from './reranker.ts';
import { vectorStore } from './vector-store.ts';
import { loadConfig } from './config.ts';
import { convertFileToMarkdown } from './document-markdown.ts';
import { ensureRagEmbeddingRuntime } from './rag/embedding-runtime.ts';
import {
  saveRagDocument, listRagDocumentsDb, deleteRagDocumentDb,
  deleteRagDocumentsByChat
} from './chat-db.ts';
import { createLogger } from './utils/logger.ts';

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const log = createLogger('[RAG]');

let vectorStoreReady = false;

async function ensureVectorStore(): Promise<void> {
  if (vectorStoreReady) return;
  try {
    await vectorStore.init();
    vectorStoreReady = true;
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

async function indexRecordEmbeddings(chatId: string, record: { doc: Record<string, unknown>; chunks: Array<{ text: string }> }): Promise<void> {
  const chunkTexts = record.chunks.map((chunk) => chunk.text).filter((text) => text.trim());
  if (chunkTexts.length === 0) return;

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

function chunkTextSemantic(text: string, chunkSize = 512): string[] {
  const targetSize = Math.max(128, Number(chunkSize) || 512);

  // Phase 1: Split on structural boundaries
  const structuralParts = splitByStructure(text);

  // Phase 2: Split each structural part on paragraph boundaries
  const paragraphs = [];
  for (const part of structuralParts) {
    if (part.length <= targetSize) {
      paragraphs.push(part);
    } else {
      const subParts = part.split(/\n\n+/).filter(p => p.trim());
      for (const sp of subParts) {
        paragraphs.push(sp.trim());
      }
    }
  }

  // Phase 3: Merge paragraphs up to target chunk size
  const chunks = [];
  let current = '';
  for (const para of paragraphs) {
    if (!para.trim()) continue;
    if (current.length + para.length + 2 > targetSize && current.length > 0) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  // Phase 4: Split any remaining oversized chunks on sentence boundaries
  const finalChunks = [];
  for (const chunk of chunks) {
    if (chunk.length <= targetSize) {
      finalChunks.push(chunk);
    } else {
      const sentences = chunk.split(/(?<=[.!?])\s+/);
      let subChunk = '';
      for (const sentence of sentences) {
        if (subChunk.length + sentence.length + 1 > targetSize && subChunk.length > 0) {
          finalChunks.push(subChunk.trim());
          subChunk = sentence;
        } else {
          subChunk = subChunk ? `${subChunk} ${sentence}` : sentence;
        }
      }
      if (subChunk.trim()) finalChunks.push(subChunk.trim());
    }
  }

  return finalChunks.length > 0 ? finalChunks : [text.slice(0, targetSize)];
}

function splitByStructure(text: string): string[] {
  const parts = [];
  let current = '';
  let inCodeBlock = false;

  const lines = text.split('\n');
  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      current += (current ? '\n' : '') + line;
      if (!inCodeBlock) {
        parts.push(current.trim());
        current = '';
      }
      continue;
    }

    if (inCodeBlock) {
      current += (current ? '\n' : '') + line;
      continue;
    }

    const isHeader = /^#{1,6}\s/.test(line.trimStart());
    const isHr = /^(---+|\*\*\*+|___+)\s*$/.test(line.trim());

    if (isHeader || isHr) {
      if (current.trim()) parts.push(current.trim());
      current = line;
    } else {
      current += (current ? '\n' : '') + line;
    }
  }

  if (current.trim()) parts.push(current.trim());
  return parts.filter(p => p.length > 0);
}

function tokenize(text: string): string[] {
  return String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

function scoreChunk(queryTokens: string[], chunkText: string): number {
  if (!queryTokens.length) return 0;
  const tokens = tokenize(chunkText);
  if (!tokens.length) return 0;

  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) || 0) + 1);
  }

  let matched = 0;
  let weighted = 0;
  for (const token of queryTokens) {
    const count = counts.get(token) || 0;
    if (!count) continue;
    matched += 1;
    weighted += 1 + Math.log2(count + 1) * 0.3;
  }

  const coverage = matched / queryTokens.length;
  const density = weighted / Math.sqrt(tokens.length + 4);
  const phrase = queryTokens.length > 1 && String(chunkText || '').toLowerCase().includes(queryTokens.join(' ')) ? 1.5 : 0;
  return (coverage * 3) + (density * 2) + phrase;
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
  const tmpPath = `${storePath}.tmp`;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(serializeStore(), null, 2));
  fs.renameSync(tmpPath, storePath);
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
              const c = chunk as { id?: string; doc_id?: string; text?: string; index?: number };
              return {
                id: String(c.id || `${doc.id}_${index}`),
                doc_id: String(c.doc_id || doc.id),
                text: String(c.text || ''),
                index: Number.isFinite(c.index) ? Number(c.index) : index
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
async function extractText(filePath: string): Promise<{ text: string; fileType: string }> {
  try {
    const { markdown, fileType } = await convertFileToMarkdown(filePath);
    return { text: markdown.trim(), fileType };
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
  const chunks = chunkTextSemantic(normalizedText, chunk_size || 512);
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
      text: chunk,
      index
    }))
  };
}

async function ingestTextInternal({ source, text, chat_id, file_type, chunk_size, background = false }: { source: string; text: string; chat_id: string; file_type: string; chunk_size?: number; background?: boolean }): Promise<Record<string, unknown>> {
  ensureStoreLoaded();
  const chatId = requireChatId(chat_id);
  const store = ensureChatStore(chatId);
  const record = buildDocumentRecord({ source, text, chat_id: chatId, file_type, chunk_size });
  store.set(record.doc.id as string, record);
  persistStore();

  // Save metadata to SQLite
  try {
    saveRagDocument(record.doc);
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

export async function ingestDocument({ file_path, chat_id, chunk_size }: { file_path: string; chat_id: string; chunk_size?: number }): Promise<Record<string, unknown>> {
  const chatId = requireChatId(chat_id);
  const fileName = path.basename(file_path);
  const { text, fileType } = await extractText(file_path);
  return ingestTextInternal({
    source: fileName,
    text,
    chat_id: chatId,
    file_type: fileType,
    chunk_size
  });
}

export async function ingestText({ source, text, chat_id, file_type, chunk_size }: { source: string; text: string; chat_id: string; file_type: string; chunk_size?: number }): Promise<Record<string, unknown>> {
  requireChatId(chat_id);
  return ingestTextInternal({ source, text, chat_id, file_type, chunk_size });
}

export async function ingestTextFast({ source, text, chat_id, file_type, chunk_size }: { source: string; text: string; chat_id: string; file_type: string; chunk_size?: number }): Promise<Record<string, unknown>> {
  requireChatId(chat_id);
  return ingestTextInternal({ source, text, chat_id, file_type, chunk_size, background: true });
}

export async function queryDocuments({ query, chat_id, top_k }: { query: string; chat_id: string; top_k?: number }): Promise<Record<string, unknown>> {
  requireChatId(chat_id);
  return queryDocumentsHybrid({ query, chat_id, top_k });
}

async function queryDocumentsHybrid({ query, chat_id, top_k }: { query: string; chat_id: string; top_k?: number }): Promise<Record<string, unknown>> {
  const chatId = requireChatId(chat_id);
  await ensureVectorStore().catch(() => {});
  await ensureRagEmbeddingRuntime().catch(() => {});
  ensureStoreLoaded();
  const store = ensureChatStore(chatId);
  const settings = getRagRuntimeSettings();
  const k = Math.max(1, Number(top_k) || 5);
  const queryTokens = tokenize(query);
  const allChunks = [];

  // Gather all chunks from in-memory store
  for (const { doc, chunks } of store.values()) {
    for (const chunk of chunks) {
      allChunks.push({ chunk, doc, text: chunk.text });
    }
  }

  if (!allChunks.length) {
    return { results: [], context: '' };
  }

  // Fast path for smaller datasets: keyword scoring only
  if (allChunks.length <= SMALL_DATASET_FAST_PATH_CHUNKS) {
    const scored = allChunks.map((entry) => ({
      chunk: entry.chunk,
      doc: entry.doc,
      score: scoreChunk(queryTokens, entry.text) + scoreChunk(queryTokens, entry.doc.source) * 0.5
    }));
    scored.sort((left, right) => right.score - left.score);
    const perDocCount = new Map();
    const selected = [];
    for (const entry of scored) {
      const docId = entry.chunk.doc_id;
      const seenCount = perDocCount.get(docId) || 0;
      if (seenCount >= 2) continue;
      perDocCount.set(docId, seenCount + 1);
      selected.push(entry);
      if (selected.length >= k) break;
    }

    return {
      results: selected.map((entry) => ({
        chunk: entry.chunk,
        score: entry.score,
        document: entry.doc
      })),
      context: selected
        .map((entry) => {
          const header = entry.doc?.source ? `### ${entry.doc.source}` : '### Document';
          return [header, entry.chunk.text].join('\n');
        })
        .join('\n\n---\n\n')
    };
  }

  // Try LanceDB vector search first
  let vectorResults = [];
  const queryEmbedding = await getCachedQueryEmbedding(query, chatId);
  if (vectorStoreReady && queryEmbedding) {
    try {
      vectorResults = await vectorStore.search(chatId, queryEmbedding, Math.max(k * 2, 8));
    } catch (err: unknown) {
      log.warn('LanceDB search failed, using in-memory scoring:', toErrorMessage(err));
    }
  }

  // If LanceDB returned results, use them for vector scoring
  const scored = [];
  const vectorResultMap = new Map();
  for (const vr of vectorResults) {
    vectorResultMap.set(vr.id, vr._distance != null ? 1 - vr._distance : 0);
  }

  // If vector results are available, score only that candidate set for speed.
  if (vectorResultMap.size > 0) {
    const chunkById = new Map(allChunks.map((entry) => [entry.chunk.id, entry]));
    for (const [chunkId, vectorScore] of vectorResultMap.entries()) {
      const entry = chunkById.get(chunkId);
      if (!entry) continue;
      const keywordScore = scoreChunk(queryTokens, entry.text) + scoreChunk(queryTokens, entry.doc.source) * 0.5;
      const hybridScore = (keywordScore * 0.25) + (vectorScore * 10 * 0.75);
      scored.push({
        chunk: entry.chunk,
        doc: entry.doc,
        text: entry.text,
        score: hybridScore,
        keywordScore,
        vectorScore
      });
    }
  }

  // Fallback path when vector retrieval is unavailable.
  if (!scored.length) {
    for (let i = 0; i < allChunks.length; i++) {
      const entry = allChunks[i];
      const keywordScore = scoreChunk(queryTokens, entry.text) + scoreChunk(queryTokens, entry.doc.source) * 0.5;
      scored.push({
        chunk: entry.chunk,
        doc: entry.doc,
        text: entry.text,
        score: keywordScore,
        keywordScore,
        vectorScore: 0
      });
    }
  }

  scored.sort((left, right) => right.score - left.score);

  // Rerank top candidates if reranker available
  const topCandidates = scored.slice(0, Math.min(Math.max(k * 2, 6), scored.length));
  let finalRanked = topCandidates;
  if (settings.rerank && topCandidates.length > 1) {
    try {
      const reranked = await rerankChunks(query, topCandidates.map(c => c.text), Math.min(k, topCandidates.length));
      if (reranked.length > 0 && reranked[0].rerankScore != null) {
        const rerankMap = new Map();
        for (const r of reranked) {
          rerankMap.set(r.text, r.rerankScore);
        }
        for (const entry of topCandidates) {
          if (rerankMap.has(entry.text)) {
            entry.rerankScore = rerankMap.get(entry.text);
          }
        }
        finalRanked = topCandidates.sort((a, b) => {
          if (a.rerankScore != null && b.rerankScore != null) return b.rerankScore - a.rerankScore;
          return b.score - a.score;
        });
      }
    } catch {
    // Reranker unavailable, use hybrid scores
  }
  }

  const perDocCount = new Map();
  const selected = [];
  for (const entry of finalRanked) {
    const docId = entry.chunk.doc_id;
    const seenCount = perDocCount.get(docId) || 0;
    if (seenCount >= 2) continue;
    perDocCount.set(docId, seenCount + 1);
    selected.push(entry);
    if (selected.length >= k) break;
  }

  return {
    results: selected.map((entry) => ({
      chunk: entry.chunk,
      score: entry.score,
      document: entry.doc
    })),
    context: selected
      .map((entry) => {
        const header = entry.doc?.source ? `### ${entry.doc.source}` : '### Document';
        return [header, entry.chunk.text].join('\n');
      })
      .join('\n\n---\n\n')
  };
}

export async function listRagDocuments(chatId: string): Promise<Record<string, unknown>[]> {
  const key = requireChatId(chatId);
  ensureStoreLoaded();
  const store = ensureChatStore(key);
  return Array.from(store.values()).map((entry) => entry.doc);
}

export async function removeRagDocument(docId: string, chatId: string): Promise<boolean> {
  const key = requireChatId(chatId);
  ensureStoreLoaded();
  const store = ensureChatStore(key);
  const removed = store.delete(docId);
  if (removed) {
    persistStore();
    // Clean up LanceDB
    if (vectorStoreReady) {
      try { await vectorStore.deleteDocument(key, docId); } catch {}
    }
    // Clean up SQLite
    try { deleteRagDocumentDb(docId); } catch {}
  }
  return removed;
}

export async function clearRagDocuments(chatId: string): Promise<boolean> {
  const key = requireChatId(chatId);
  ensureStoreLoaded();
  const removed = chatDocuments.delete(key);
  if (removed) {
    persistStore();
    // Clean up LanceDB
    if (vectorStoreReady) {
      try { await vectorStore.deleteChat(key); } catch {}
    }
    // Clean up SQLite
    try { deleteRagDocumentsByChat(key); } catch {}
  }
  return removed;
}

export async function hasRagDocuments(chatId: string): Promise<boolean> {
  const key = requireChatId(chatId);
  ensureStoreLoaded();
  const store = chatDocuments.get(key);
  return !!store && store.size > 0;
}

/**
 * One-time migration: reads the legacy JSON store and bulk-inserts
 * all chunks into LanceDB with embeddings, plus metadata into SQLite.
 * Called once at startup if a migration marker file is absent.
 */
async function migrateFromJsonStore() {
  const storePath = getStorePath();
  if (!fs.existsSync(storePath)) return;

  await ensureVectorStore();
  if (!vectorStoreReady) {
    log.warn('Skipping migration — LanceDB not available');
    return;
  }

  const markerPath = storePath + '.migrated';
  if (fs.existsSync(markerPath)) return;

  log.info('Migrating JSON store to LanceDB...');
  ensureStoreLoaded();

  let migrated = 0;
  for (const [chatId, docs] of chatDocuments.entries()) {
    for (const { doc, chunks } of docs.values()) {
      const chunkTexts = chunks.map(c => c.text).filter(t => t.trim());
      if (chunkTexts.length === 0) continue;

      const embeddings = await getEmbeddings(chunkTexts).catch(() => null);
      if (!embeddings) continue;

      try {
        await vectorStore.addChunks(chatId, doc, chunks, embeddings);
        saveRagDocument(doc);
        migrated++;
      } catch (err: unknown) {
        log.warn(`Migration failed for doc ${doc.id}:`, toErrorMessage(err));
      }
    }
  }

  // Mark migration as done (backup old file, don't delete)
  fs.writeFileSync(markerPath, JSON.stringify({ migrated, at: new Date().toISOString() }));
  log.info(`Migration complete: ${migrated} documents migrated to LanceDB`);
}

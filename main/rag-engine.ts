import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getAppPaths } from './paths.ts';
import { getEmbedding, getEmbeddings } from './embedding-client.ts';
import { rerankChunks } from './reranker.ts';
import { vectorStore } from './vector-store.ts';
import { loadConfig } from './config.ts';
import { ensureRagEmbeddingRuntime } from './rag/embedding-runtime.ts';
import {
  saveRagDocument, listRagDocumentsDb, deleteRagDocumentDb,
  deleteRagDocumentsByChat
} from './chat-db.ts';

let vectorStoreReady = false;

async function ensureVectorStore() {
  if (vectorStoreReady) return;
  try {
    await vectorStore.init();
    vectorStoreReady = true;
  } catch (err) {
    console.warn('[RAG] LanceDB init failed, falling back to JSON store:', err?.message || err);
  }
}

const chatDocuments = new Map();
let storeLoaded = false;
let storeMtime = 0;
const queryEmbeddingCache = new Map();
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

function queryEmbeddingCacheKey(query, chatId) {
  return `${String(chatId || 'default')}:${String(query || '').trim().toLowerCase()}`;
}

function setQueryEmbeddingCache(key, embedding) {
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

function getQueryEmbeddingCache(key) {
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

async function getCachedQueryEmbedding(query, chatId) {
  const key = queryEmbeddingCacheKey(query, chatId);
  const fromCache = getQueryEmbeddingCache(key);
  if (fromCache) return fromCache;
  const embedding = await getEmbedding(query);
  if (embedding) setQueryEmbeddingCache(key, embedding);
  return embedding;
}

async function indexRecordEmbeddings(chatId, record) {
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
  } catch (err) {
    console.warn('[RAG] LanceDB addChunks failed:', err?.message || err);
  }
}

function getStorePath() {
  const { cacheRoot } = getAppPaths();
  return path.join(cacheRoot, 'rag-store-v2.json');
}

function chunkTextSemantic(text, chunkSize = 512) {
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

function splitByStructure(text) {
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

function tokenize(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

function scoreChunk(queryTokens, chunkText) {
  if (!queryTokens.length) return 0;
  const tokens = tokenize(chunkText);
  if (!tokens.length) return 0;

  const counts = new Map();
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

function ensureChatStore(chatId) {
  const key = String(chatId || 'default');
  if (!chatDocuments.has(key)) {
    chatDocuments.set(key, new Map());
  }
  return chatDocuments.get(key);
}

function serializeStore() {
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

function persistStore() {
  const storePath = getStorePath();
  const directory = path.dirname(storePath);
  const tmpPath = `${storePath}.tmp`;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(serializeStore(), null, 2));
  fs.renameSync(tmpPath, storePath);
}

function hydrateStore(raw) {
  chatDocuments.clear();
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.chats)) return;

  for (const chatEntry of raw.chats) {
    const chatId = String(chatEntry?.chatId || 'default');
    const docs = new Map();
    for (const docEntry of Array.isArray(chatEntry?.documents) ? chatEntry.documents : []) {
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
          ? docEntry.chunks.map((chunk, index) => ({
              id: String(chunk.id || `${doc.id}_${index}`),
              doc_id: String(chunk.doc_id || doc.id),
              text: String(chunk.text || ''),
              index: Number.isFinite(chunk.index) ? Number(chunk.index) : index
            }))
          : []
      });
    }
    chatDocuments.set(chatId, docs);
  }
}

function ensureStoreLoaded() {
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
    } catch (err) {
      console.warn('[RAG] Failed to load persisted store, starting fresh:', err?.message || err);
      chatDocuments.clear();
    }
  }
  storeLoaded = true;
}

async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  function hasUsablePdfText(text) {
    const normalized = String(text || '').replace(/\u0000/g, ' ').trim();
    if (normalized.length < 80) return false;
    const wordMatches = normalized.match(/[\p{L}\p{N}]{2,}/gu) || [];
    return wordMatches.length >= 20;
  }

  if (ext === '.pdf') {
    try {
      const pdfParse = (await import('pdf-parse')).default;
      const buffer = fs.readFileSync(filePath);
      const data = await pdfParse(buffer);
      const text = String(data?.text || '').replace(/\u0000/g, ' ').trim();
      if (!hasUsablePdfText(text)) {
        throw new Error('PDF parser returned insufficient readable text');
      }
      return { text, fileType: 'pdf' };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err || 'unknown parser error');
      throw new Error(`Could not parse PDF text: ${reason}`);
    }
  }

  if (ext === '.docx') {
    try {
      const mammoth = (await import('mammoth')).default;
      const result = await mammoth.extractRawText({ path: filePath });
      return { text: result.value, fileType: 'docx' };
    } catch {
      return { text: fs.readFileSync(filePath, 'utf8'), fileType: 'text' };
    }
  }

  const fileType = ext === '.md' ? 'markdown' : ext === '.json' ? 'json' : 'text';
  return { text: fs.readFileSync(filePath, 'utf8'), fileType };
}

function makeDocumentFingerprint(source, text, fileType) {
  return createHash('sha1')
    .update(`${source || 'unknown'}\n${fileType || 'text'}\n${text || ''}`)
    .digest('hex');
}

function buildDocumentRecord({ source, text, chat_id, file_type, chunk_size }) {
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
      chat_id: String(chat_id || 'default')
    },
    chunks: chunks.map((chunk, index) => ({
      id: `${docId}_${index}`,
      doc_id: docId,
      text: chunk,
      index
    }))
  };
}

async function ingestTextInternal({ source, text, chat_id, file_type, chunk_size, background = false }) {
  ensureStoreLoaded();
  const store = ensureChatStore(chat_id);
  const record = buildDocumentRecord({ source, text, chat_id, file_type, chunk_size });
  store.set(record.doc.id, record);
  persistStore();

  // Save metadata to SQLite
  try {
    saveRagDocument(record.doc);
  } catch (err) {
    console.warn('[RAG] Failed to save doc metadata to SQLite:', err?.message || err);
  }

  const indexTask = indexRecordEmbeddings(chat_id, record);
  if (background) {
    void indexTask.catch((err) => {
      console.warn('[RAG] Background indexing failed:', err?.message || err);
    });
  } else {
    await indexTask;
  }

  return record.doc;
}

export async function ingestDocument({ file_path, chat_id, chunk_size }) {
  const fileName = path.basename(file_path);
  const { text, fileType } = await extractText(file_path);
  return ingestTextInternal({
    source: fileName,
    text,
    chat_id,
    file_type: fileType,
    chunk_size
  });
}

export async function ingestText({ source, text, chat_id, file_type, chunk_size }) {
  return ingestTextInternal({ source, text, chat_id, file_type, chunk_size });
}

export async function ingestTextFast({ source, text, chat_id, file_type, chunk_size }) {
  return ingestTextInternal({ source, text, chat_id, file_type, chunk_size, background: true });
}

export async function queryDocuments({ query, chat_id, top_k }) {
  return queryDocumentsHybrid({ query, chat_id, top_k });
}

async function queryDocumentsHybrid({ query, chat_id, top_k }) {
  await ensureVectorStore().catch(() => {});
  await ensureRagEmbeddingRuntime().catch(() => {});
  ensureStoreLoaded();
  const store = ensureChatStore(chat_id);
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
  const queryEmbedding = await getCachedQueryEmbedding(query, chat_id);
  if (vectorStoreReady && queryEmbedding) {
    try {
      vectorResults = await vectorStore.search(chat_id, queryEmbedding, Math.max(k * 2, 8));
    } catch (err) {
      console.warn('[RAG] LanceDB search failed, using in-memory scoring:', err?.message || err);
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

export async function listRagDocuments(chatId) {
  ensureStoreLoaded();
  const store = ensureChatStore(chatId);
  return Array.from(store.values()).map((entry) => entry.doc);
}

export async function removeRagDocument(docId, chatId) {
  ensureStoreLoaded();
  const store = ensureChatStore(chatId);
  const removed = store.delete(docId);
  if (removed) {
    persistStore();
    // Clean up LanceDB
    if (vectorStoreReady) {
      try { await vectorStore.deleteDocument(chatId, docId); } catch {}
    }
    // Clean up SQLite
    try { deleteRagDocumentDb(docId); } catch {}
  }
  return removed;
}

export async function clearRagDocuments(chatId) {
  ensureStoreLoaded();
  const key = String(chatId || 'default');
  const removed = chatDocuments.delete(key);
  if (removed) {
    persistStore();
    // Clean up LanceDB
    if (vectorStoreReady) {
      try { await vectorStore.deleteChat(chatId); } catch {}
    }
    // Clean up SQLite
    try { deleteRagDocumentsByChat(chatId); } catch {}
  }
  return removed;
}

export async function hasRagDocuments(chatId) {
  ensureStoreLoaded();
  const store = chatDocuments.get(String(chatId || 'default'));
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
    console.warn('[RAG] Skipping migration — LanceDB not available');
    return;
  }

  const markerPath = storePath + '.migrated';
  if (fs.existsSync(markerPath)) return;

  console.log('[RAG] Migrating JSON store to LanceDB...');
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
      } catch (err) {
        console.warn(`[RAG] Migration failed for doc ${doc.id}:`, err?.message || err);
      }
    }
  }

  // Mark migration as done (backup old file, don't delete)
  fs.writeFileSync(markerPath, JSON.stringify({ migrated, at: new Date().toISOString() }));
  console.log(`[RAG] Migration complete: ${migrated} documents migrated to LanceDB`);
}

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getAppPaths } from './index.js';

const chatDocuments = new Map();
let storeLoaded = false;
let storeMtime = 0;

function getStorePath() {
  const { cacheRoot } = getAppPaths();
  return path.join(cacheRoot, 'rag-store-v2.json');
}

function chunkText(text, chunkSize = 512, overlap = 64) {
  const safeChunkSize = Math.max(128, Number(chunkSize) || 512);
  const safeOverlap = Math.max(0, Math.min(Number(overlap) || 64, safeChunkSize - 1));
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + safeChunkSize, text.length);
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start = Math.max(0, end - safeOverlap);
  }

  return chunks;
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

  if (ext === '.pdf') {
    try {
      const pdfParse = (await import('pdf-parse')).default;
      const buffer = fs.readFileSync(filePath);
      const data = await pdfParse(buffer);
      return { text: data.text, fileType: 'pdf' };
    } catch {
      const raw = fs.readFileSync(filePath, 'latin1');
      const text = raw.replace(/[^\x20-\x7E\n\r\t]/g, ' ').replace(/\s{3,}/g, '\n').trim();
      return { text, fileType: 'pdf' };
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

function buildDocumentRecord({ source, text, chat_id, file_type, chunk_size, overlap }) {
  const normalizedText = String(text || '').trim();
  const chunks = chunkText(normalizedText, chunk_size || 512, overlap || 64);
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

function ingestTextInternal({ source, text, chat_id, file_type, chunk_size, overlap }) {
  ensureStoreLoaded();
  const store = ensureChatStore(chat_id);
  const record = buildDocumentRecord({ source, text, chat_id, file_type, chunk_size, overlap });
  store.set(record.doc.id, record);
  persistStore();
  return record.doc;
}

export async function ingestDocument({ file_path, chat_id, chunk_size, overlap }) {
  const fileName = path.basename(file_path);
  const { text, fileType } = await extractText(file_path);
  return ingestTextInternal({
    source: fileName,
    text,
    chat_id,
    file_type: fileType,
    chunk_size,
    overlap
  });
}

export async function ingestText({ source, text, chat_id, file_type, chunk_size, overlap }) {
  return ingestTextInternal({ source, text, chat_id, file_type, chunk_size, overlap });
}

export async function queryDocuments({ query, chat_id, top_k }) {
  ensureStoreLoaded();
  const store = ensureChatStore(chat_id);
  const k = Math.max(1, Number(top_k) || 5);
  const queryTokens = tokenize(query);
  const allChunks = [];

  for (const { doc, chunks } of store.values()) {
    for (const chunk of chunks) {
      allChunks.push({
        chunk,
        doc,
        score: scoreChunk(queryTokens, chunk.text) + scoreChunk(queryTokens, doc.source) * 0.5
      });
    }
  }

  if (!allChunks.length) {
    return { results: [], context: '' };
  }

  allChunks.sort((left, right) => right.score - left.score);
  const perDocCount = new Map();
  const selected = [];

  for (const entry of allChunks) {
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
  if (removed) persistStore();
  return removed;
}

export async function clearRagDocuments(chatId) {
  ensureStoreLoaded();
  const key = String(chatId || 'default');
  const removed = chatDocuments.delete(key);
  if (removed) persistStore();
  return removed;
}

export async function hasRagDocuments(chatId) {
  ensureStoreLoaded();
  const store = chatDocuments.get(String(chatId || 'default'));
  return !!store && store.size > 0;
}

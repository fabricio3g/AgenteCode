import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { getAppPaths } from './paths.ts';

let db = null;

function getDbPath() {
  const { cacheRoot } = getAppPaths();
  return path.join(cacheRoot, 'chat-history.db');
}

function getDb() {
  if (db) return db;
  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      folder_id TEXT,
      draft TEXT NOT NULL DEFAULT '',
      context_mode TEXT DEFAULT 'chat',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL DEFAULT '',
      reasoning TEXT,
      model TEXT,
      created_at INTEGER NOT NULL,
      done INTEGER DEFAULT 1,
      status TEXT DEFAULT 'idle',
      search_mode TEXT,
      mode TEXT,
      agent_task_id TEXT,
      active_version INTEGER,
      folder_id TEXT,
      FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      name TEXT,
      size INTEGER DEFAULT 0,
      type TEXT,
      url TEXT,
      preview TEXT,
      base64 TEXT,
      kind TEXT,
      status TEXT,
      doc_id TEXT,
      ocr_text TEXT,
      error TEXT,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS message_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      reasoning TEXT,
      created_at INTEGER NOT NULL,
      model_name TEXT,
      tokens INTEGER,
      timing REAL,
      tokens_per_second REAL,
      error INTEGER DEFAULT 0,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      parent_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
    CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON attachments(message_id);
    CREATE INDEX IF NOT EXISTS idx_folders_parent_id ON folders(parent_id);
    CREATE INDEX IF NOT EXISTS idx_chats_updated_at ON chats(updated_at);

    CREATE TABLE IF NOT EXISTS rag_documents (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'unknown',
      file_type TEXT NOT NULL DEFAULT 'text',
      chunk_count INTEGER NOT NULL DEFAULT 0,
      char_count INTEGER NOT NULL DEFAULT 0,
      fingerprint TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_rag_documents_chat_id ON rag_documents(chat_id);
  `);

  // Migration: add tts_audio column if missing
  try {
    database.prepare('ALTER TABLE messages ADD COLUMN tts_audio TEXT').run();
  } catch {
    // Column already exists
  }
}

export function saveChatSession(session) {
  const database = getDb();
  const upsertChat = database.prepare(`
    INSERT INTO chats (id, title, folder_id, draft, context_mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      folder_id = excluded.folder_id,
      draft = excluded.draft,
      context_mode = excluded.context_mode,
      updated_at = excluded.updated_at
  `);

  const upsertMessage = database.prepare(`
    INSERT INTO messages (id, chat_id, role, content, reasoning, model, created_at, done, status, search_mode, mode, agent_task_id, active_version, tts_audio)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      content = excluded.content,
      reasoning = excluded.reasoning,
      model = excluded.model,
      done = excluded.done,
      status = excluded.status,
      search_mode = excluded.search_mode,
      mode = excluded.mode,
      agent_task_id = excluded.agent_task_id,
      active_version = excluded.active_version,
      tts_audio = excluded.tts_audio
  `);

  const deleteAttachments = database.prepare('DELETE FROM attachments WHERE message_id = ?');
  const insertAttachment = database.prepare(`
    INSERT INTO attachments (id, message_id, name, size, type, url, preview, base64, kind, status, doc_id, ocr_text, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const deleteVersions = database.prepare('DELETE FROM message_versions WHERE message_id = ?');
  const insertVersion = database.prepare(`
    INSERT INTO message_versions (message_id, content, reasoning, created_at, model_name, tokens, timing, tokens_per_second, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = database.transaction(() => {
    upsertChat.run(
      session.id,
      session.title || '',
      session.folderId || null,
      session.draft || '',
      session.contextMode || 'chat',
      session.createdAt || Date.now(),
      session.updatedAt || Date.now()
    );

    for (const msg of session.messages || []) {
      upsertMessage.run(
        msg.id,
        session.id,
        msg.role,
        msg.content || '',
        msg.reasoning || null,
        msg.model || null,
        msg.createdAt || Date.now(),
        msg.done !== false ? 1 : 0,
        msg.status || 'idle',
        msg.searchMode || null,
        msg.mode || null,
        null,
        msg.activeVersion != null ? msg.activeVersion : null,
        msg.ttsAudio ? JSON.stringify(msg.ttsAudio) : null
      );

      // Attachments
      deleteAttachments.run(msg.id);
      for (const att of msg.attachments || []) {
        insertAttachment.run(
          att.id,
          msg.id,
          att.name || null,
          att.size || 0,
          att.type || null,
          att.url || null,
          att.preview || null,
          att.base64 || null,
          att.kind || null,
          att.status || null,
          att.docId || null,
          att.ocrText || null,
          att.error || null
        );
      }

      // Versions
      deleteVersions.run(msg.id);
      for (const ver of msg.versions || []) {
        insertVersion.run(
          msg.id,
          ver.content || '',
          ver.reasoning || null,
          ver.createdAt || Date.now(),
          ver.metadata?.modelName || null,
          ver.metadata?.tokens || null,
          ver.metadata?.timing || null,
          ver.metadata?.tokensPerSecond || null,
          ver.metadata?.error ? 1 : 0
        );
      }
    }
  });

  transaction();
}

export function loadAllChats() {
  const database = getDb();
  const chats = database.prepare('SELECT * FROM chats ORDER BY updated_at DESC').all();
  const msgStmt = database.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC');
  const attStmt = database.prepare('SELECT * FROM attachments WHERE message_id = ?');
  const verStmt = database.prepare('SELECT * FROM message_versions WHERE message_id = ? ORDER BY created_at ASC');

  return chats.map(chat => {
    const messages = msgStmt.all(chat.id).map(msg => {
      const attachments = attStmt.all(msg.id).map(att => ({
        id: att.id,
        name: att.name || '',
        size: att.size || 0,
        type: att.type || '',
        url: att.url || undefined,
        preview: att.preview || undefined,
        base64: att.base64 || undefined,
        kind: att.kind || undefined,
        status: att.status || undefined,
        docId: att.doc_id || undefined,
        ocrText: att.ocr_text || undefined,
        error: att.error || undefined
      }));

      const versions = verStmt.all(msg.id).map(ver => ({
        content: ver.content,
        reasoning: ver.reasoning || undefined,
        createdAt: ver.created_at,
        metadata: {
          modelName: ver.model_name || undefined,
          tokens: ver.tokens || undefined,
          timing: ver.timing || undefined,
          tokensPerSecond: ver.tokens_per_second || undefined,
          error: !!ver.error
        }
      }));

      const result = {
        id: msg.id,
        role: msg.role,
        content: msg.content,
        createdAt: msg.created_at,
        done: !!msg.done,
        status: msg.status || 'idle'
      };
      if (msg.reasoning) result.reasoning = msg.reasoning;
      if (msg.model) result.model = msg.model;
      if (msg.search_mode) result.searchMode = msg.search_mode;
      if (msg.mode) result.mode = msg.mode;
      if (msg.active_version != null) result.activeVersion = msg.active_version;
      if (msg.tts_audio) {
        try { result.ttsAudio = JSON.parse(msg.tts_audio); } catch { /* ignore parse errors */ }
      }
      if (attachments.length) result.attachments = attachments;
      if (versions.length) result.versions = versions;
      return result;
    });

    const session = {
      id: chat.id,
      title: chat.title,
      createdAt: chat.created_at,
      updatedAt: chat.updated_at,
      folderId: chat.folder_id,
      draft: chat.draft || '',
      contextMode: chat.context_mode || 'chat',
      messages
    };
    return session;
  });
}

export function loadAllFolders() {
  const database = getDb();
  return database.prepare('SELECT * FROM folders ORDER BY created_at ASC').all().map(f => ({
    id: f.id,
    name: f.name,
    parentId: f.parent_id,
    createdAt: f.created_at
  }));
}

export function saveFolder(folder) {
  const database = getDb();
  database.prepare(`
    INSERT INTO folders (id, name, parent_id, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, parent_id = excluded.parent_id
  `).run(folder.id, folder.name, folder.parentId || null, folder.createdAt || Date.now());
}

export function deleteFolder(folderId) {
  const database = getDb();
  database.prepare('DELETE FROM folders WHERE id = ?').run(folderId);
}

export function deleteChat(chatId) {
  const database = getDb();
  database.prepare('DELETE FROM chats WHERE id = ?').run(chatId);
}

export function migrateFromLocalStorage(persistedState) {
  if (!persistedState || typeof persistedState !== 'object') return 0;
  const chats = persistedState.chats || [];
  const folders = persistedState.folders || [];
  let migrated = 0;

  const database = getDb();
  const transaction = database.transaction(() => {
    for (const folder of folders) {
      if (!folder?.id) continue;
      saveFolder(folder);
    }
    for (const session of chats) {
      if (!session?.id) continue;
      saveChatSession(session);
      migrated++;
    }
  });
  transaction();
  return migrated;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

// --- RAG document metadata ---

export function saveRagDocument(doc) {
  const database = getDb();
  database.prepare(`
    INSERT INTO rag_documents (id, chat_id, source, file_type, chunk_count, char_count, fingerprint, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      chunk_count = excluded.chunk_count,
      char_count = excluded.char_count,
      fingerprint = excluded.fingerprint,
      updated_at = excluded.updated_at
  `).run(doc.id, doc.chat_id, doc.source, doc.file_type, doc.chunk_count, doc.char_count, doc.fingerprint, doc.created_at, doc.updated_at);
}

function listRagDocumentsDb(chatId) {
  const database = getDb();
  return database.prepare('SELECT * FROM rag_documents WHERE chat_id = ? ORDER BY created_at DESC').all(chatId);
}

export function deleteRagDocumentDb(docId) {
  const database = getDb();
  return database.prepare('DELETE FROM rag_documents WHERE id = ?').run(docId).changes > 0;
}

export function deleteRagDocumentsByChat(chatId) {
  const database = getDb();
  return database.prepare('DELETE FROM rag_documents WHERE chat_id = ?').run(chatId).changes;
}

import Database from './sqlite.ts';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getAppPaths } from './paths.ts';

let db = null;
let databasePath: string | undefined;
const messageFingerprints = new Map<string, string>();
const chatMessageIds = new Map<string, Set<string>>();
/** Workers receive the resolved path; Electron's app API stays on the main thread. */
export function setChatDbPath(value: string) { if (db) throw new Error('Database already open'); databasePath = value; }


function stringifyJson(value) {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function parseJson(raw, fallback = null) {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function addColumn(database, table, column, definition) {
  try {
    database.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  } catch {
    // Column already exists
  }
}

function getDbPath() {
  if (databasePath) return databasePath;
  const { cacheRoot } = getAppPaths();
  return path.join(cacheRoot, 'chat-history.db');
}

function getDb() {
  if (db) return db;
  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
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
      code_agent TEXT,
      project_id TEXT,
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
      metadata TEXT,
      sources TEXT,
      search_meta TEXT,
      agent_steps TEXT,
      rag_documents TEXT,
      slides TEXT,
      work_context TEXT,
      files_created TEXT,
      artifact TEXT,
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
      data TEXT,
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
      metadata TEXT,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      parent_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS code_projects (
      id TEXT PRIMARY KEY,
      root_path TEXT NOT NULL,
      root_name TEXT NOT NULL,
      icon TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
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

    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      data TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_characters_updated_at ON characters(updated_at);

    CREATE TABLE IF NOT EXISTS personas (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      is_default INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      data TEXT
    );

    CREATE TABLE IF NOT EXISTS worlds (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      data TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_worlds_updated_at ON worlds(updated_at);

    -- Electron's file registry, keyed by content hash (sha256 hex). The copies
    -- live in this app's own attachment store (main/attachment-store.ts) — the
    -- TUI/CLI is a separate front end and the Rust core owns its own store, so
    -- these rows describe this app's files, not the machine's.
    -- spec_path/version carry the source spec of generated documents (Phase 4)
    -- and exist now so the schema never needs a second migration.
    CREATE TABLE IF NOT EXISTS files (
      hash TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      mime TEXT,
      bytes INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL DEFAULT 'file',
      stored_path TEXT,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      extract_status TEXT NOT NULL DEFAULT 'pending',
      extracted_chars INTEGER NOT NULL DEFAULT 0,
      rag_doc_id TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      origin TEXT NOT NULL DEFAULT 'upload',
      spec_path TEXT,
      version INTEGER NOT NULL DEFAULT 1
    );

    -- Which chat (and which message) uses a file. Deliberately no chat FK: a
    -- generated document can be linked before its chat row exists, and
    -- deleting a chat must not silently drop the file from the library.
    CREATE TABLE IF NOT EXISTS file_refs (
      hash TEXT NOT NULL REFERENCES files(hash) ON DELETE CASCADE,
      chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (hash, chat_id, message_id)
    );

    CREATE INDEX IF NOT EXISTS idx_file_refs_chat_id ON file_refs(chat_id);
    CREATE INDEX IF NOT EXISTS idx_file_refs_hash ON file_refs(hash);
  `);

  // Migrations for older chat-history.db files.
  addColumn(database, 'messages', 'tts_audio', 'TEXT');
  addColumn(database, 'messages', 'artifact', 'TEXT');
  // Every artifact of a turn; `artifact` alone kept only the last one.
  addColumn(database, 'messages', 'artifacts', 'TEXT');
  addColumn(database, 'messages', 'metadata', 'TEXT');
  addColumn(database, 'messages', 'sources', 'TEXT');
  addColumn(database, 'messages', 'search_meta', 'TEXT');
  addColumn(database, 'messages', 'agent_steps', 'TEXT');
  addColumn(database, 'messages', 'rag_documents', 'TEXT');
  addColumn(database, 'messages', 'slides', 'TEXT');
  addColumn(database, 'messages', 'work_context', 'TEXT');
  addColumn(database, 'messages', 'files_created', 'TEXT');
  addColumn(database, 'chats', 'code_agent', 'TEXT');
  addColumn(database, 'chats', 'home_runtime', 'TEXT');
  addColumn(database, 'chats', 'project_id', 'TEXT');
  // Session fields required for isolation + Code/Work durability
  addColumn(database, 'chats', 'workspace', 'TEXT');
  addColumn(database, 'chats', 'composer_mode', 'TEXT');
  addColumn(database, 'chats', 'search_mode', 'TEXT');
  addColumn(database, 'chats', 'reasoning_level', 'TEXT');
  addColumn(database, 'chats', 'model_selection', 'TEXT');
  addColumn(database, 'chats', 'pending_prompts', 'TEXT');
  addColumn(database, 'message_versions', 'metadata', 'TEXT');
  addColumn(database, 'attachments', 'data', 'TEXT');
  // Roleplay identity
  addColumn(database, 'chats', 'character_id', 'TEXT');
  addColumn(database, 'chats', 'persona_id', 'TEXT');
  addColumn(database, 'chats', 'world_id', 'TEXT');
  addColumn(database, 'chats', 'greeting_index', 'INTEGER');
  addColumn(database, 'chats', 'roleplay', 'TEXT');
  // Where a conversation came from: 'browser' for the extension's chat panel.
  addColumn(database, 'chats', 'origin', 'TEXT');
  addColumn(database, 'messages', 'speaker_id', 'TEXT');
  addColumn(database, 'messages', 'choices', 'TEXT');
  addColumn(database, 'messages', 'props', 'TEXT');
  addColumn(database, 'messages', 'story_turn', 'TEXT');
}

/** Draft changes never rewrite the transcript, attachments, or response versions. */
export function saveChatDraft(chatId: string, draft: string, codeAgent: unknown, updatedAt: number, pendingPrompts?: unknown): boolean {
  return getDb().prepare('UPDATE chats SET draft = ?, code_agent = ?, updated_at = ?, pending_prompts = COALESCE(?, pending_prompts) WHERE id = ?')
    .run(draft, stringifyJson(codeAgent), updatedAt, pendingPrompts === undefined ? null : stringifyJson(pendingPrompts), chatId).changes > 0;
}

export function saveChatSession(session) {
  const database = getDb();
  const upsertChat = database.prepare(`
    INSERT INTO chats (id, title, folder_id, draft, context_mode, code_agent, home_runtime, project_id, workspace, composer_mode, search_mode, reasoning_level, model_selection, pending_prompts, character_id, world_id, persona_id, greeting_index, roleplay, origin, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      folder_id = excluded.folder_id,
      draft = excluded.draft,
      context_mode = excluded.context_mode,
      code_agent = excluded.code_agent,
      home_runtime = excluded.home_runtime,
      project_id = excluded.project_id,
      workspace = excluded.workspace,
      composer_mode = excluded.composer_mode,
      search_mode = excluded.search_mode,
      reasoning_level = excluded.reasoning_level,
      model_selection = excluded.model_selection,
      pending_prompts = excluded.pending_prompts,
      character_id = excluded.character_id,
      world_id = excluded.world_id,
      persona_id = excluded.persona_id,
      greeting_index = excluded.greeting_index,
      roleplay = excluded.roleplay,
      origin = excluded.origin,
      updated_at = excluded.updated_at
  `);

  const upsertMessage = database.prepare(`
    INSERT INTO messages (id, chat_id, role, content, reasoning, model, created_at, done, status, search_mode, mode, speaker_id, choices, props, story_turn, agent_task_id, active_version, tts_audio, artifact, artifacts, metadata, sources, search_meta, agent_steps, rag_documents, slides, work_context, files_created)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      content = excluded.content,
      reasoning = excluded.reasoning,
      model = excluded.model,
      done = excluded.done,
      status = excluded.status,
      search_mode = excluded.search_mode,
      mode = excluded.mode,
      speaker_id = excluded.speaker_id,
      choices = excluded.choices,
      props = excluded.props,
      story_turn = excluded.story_turn,
      agent_task_id = excluded.agent_task_id,
      active_version = excluded.active_version,
      tts_audio = excluded.tts_audio,
      artifact = excluded.artifact,
      artifacts = excluded.artifacts,
      metadata = excluded.metadata,
      sources = excluded.sources,
      search_meta = excluded.search_meta,
      agent_steps = excluded.agent_steps,
      rag_documents = excluded.rag_documents,
      slides = excluded.slides,
      work_context = excluded.work_context,
      files_created = excluded.files_created
  `);

  const deleteAttachments = database.prepare('DELETE FROM attachments WHERE message_id = ?');
  const insertAttachment = database.prepare(`
    INSERT INTO attachments (id, message_id, name, size, type, url, preview, base64, data, kind, status, doc_id, ocr_text, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const deleteVersions = database.prepare('DELETE FROM message_versions WHERE message_id = ?');
  const insertVersion = database.prepare(`
    INSERT INTO message_versions (message_id, content, reasoning, created_at, model_name, tokens, timing, tokens_per_second, error, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const deleteOrphanMessages = database.prepare('DELETE FROM messages WHERE chat_id = ?');
  const deleteOrphanMessagesExcept = (chatId, keepIds) => {
    if (!keepIds.length) {
      deleteOrphanMessages.run(chatId);
      return;
    }
    // Prune messages no longer present in the session (prevents resurrection after delete/regenerate)
    const placeholders = keepIds.map(() => '?').join(', ');
    database.prepare(`DELETE FROM messages WHERE chat_id = ? AND id NOT IN (${placeholders})`).run(chatId, ...keepIds);
  };

  const pendingFingerprints = new Map<string, string>();
  const messageIds = new Set<string>();
  const transaction = database.transaction(() => {
    upsertChat.run(
      session.id,
      session.title || '',
      session.folderId || null,
      session.draft || '',
      session.contextMode || 'chat',
      stringifyJson(session.codeAgent),
      stringifyJson(session.homeRuntime),
      session.projectId || null,
      stringifyJson(session.workspace),
      session.composerMode || null,
      session.searchMode || null,
      session.reasoningLevel || null,
      stringifyJson(session.modelSelection),
      stringifyJson(session.pendingPrompts),
      session.characterId || null,
      session.worldId || null,
      session.personaId || null,
      session.greetingIndex != null ? session.greetingIndex : null,
      stringifyJson(session.roleplay),
      session.origin || null,
      session.createdAt || Date.now(),
      session.updatedAt || Date.now()
    );

    const messages = Array.isArray(session.messages) ? session.messages : [];
    const keepIds = messages.map((msg) => msg.id).filter(Boolean);
    deleteOrphanMessagesExcept(session.id, keepIds);

    for (const msg of messages) {
      if (!msg?.id) continue;
      messageIds.add(msg.id);
      const cacheKey = `${session.id}\0${msg.id}`;
      const fingerprint = createHash('sha256').update(JSON.stringify(msg)).digest('hex');
      if (messageFingerprints.get(cacheKey) === fingerprint) continue;
      pendingFingerprints.set(cacheKey, fingerprint);
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
        msg.speakerId || null,
        stringifyJson(msg.choices),
        stringifyJson(msg.props),
        stringifyJson(msg.storyTurn),
        null,
        msg.activeVersion != null ? msg.activeVersion : null,
        stringifyJson(msg.ttsAudio),
        stringifyJson(msg.artifact),
        Array.isArray(msg.artifacts) && msg.artifacts.length ? stringifyJson(msg.artifacts) : null,
        stringifyJson(msg.metadata),
        stringifyJson(msg.sources),
        stringifyJson(msg.searchMeta),
        stringifyJson(msg.agentSteps),
        stringifyJson(msg.ragDocuments),
        stringifyJson(msg.slides),
        stringifyJson(msg.workContext),
        stringifyJson(msg.filesCreated)
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
          att.data || null,
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
          ver.metadata?.error ? 1 : 0,
          stringifyJson(ver.metadata)
        );
      }
    }
  });

  transaction();
  // Publish fingerprints only after commit; failed transactions must be retried.
  for (const id of chatMessageIds.get(session.id) ?? []) if (!messageIds.has(id)) messageFingerprints.delete(`${session.id}\0${id}`);
  chatMessageIds.set(session.id, messageIds);
  for (const [key, fingerprint] of pendingFingerprints) messageFingerprints.set(key, fingerprint);
  while (messageFingerprints.size > 10000) messageFingerprints.delete(messageFingerprints.keys().next().value!);
}

export function loadAllChats() {
  const database = getDb();
  const chats = database.prepare('SELECT * FROM chats ORDER BY updated_at DESC').all();
  const group = (rows, key) => {
    const grouped = new Map();
    for (const row of rows) {
      const bucket = grouped.get(row[key]) ?? [];
      bucket.push(row);
      grouped.set(row[key], bucket);
    }
    return grouped;
  };
  // Four scans instead of two extra queries for every message at startup.
  const messageRows = group(database.prepare('SELECT * FROM messages ORDER BY created_at ASC').all(), 'chat_id');
  const attachmentRows = group(database.prepare('SELECT * FROM attachments').all(), 'message_id');
  const versionRows = group(database.prepare('SELECT * FROM message_versions ORDER BY created_at ASC').all(), 'message_id');

  return chats.map(chat => {
    const messages = (messageRows.get(chat.id) ?? []).map(msg => {
      const attachments = (attachmentRows.get(msg.id) ?? []).map(att => ({
        id: att.id,
        name: att.name || '',
        size: att.size || 0,
        type: att.type || '',
        url: att.url || undefined,
        preview: att.preview || undefined,
        base64: att.base64 || undefined,
        data: att.data || undefined,
        kind: att.kind || undefined,
        status: att.status || undefined,
        docId: att.doc_id || undefined,
        ocrText: att.ocr_text || undefined,
        error: att.error || undefined
      }));

      const versions = (versionRows.get(msg.id) ?? []).map(ver => {
        const metadata = {
          modelName: ver.model_name || undefined,
          tokens: ver.tokens || undefined,
          timing: ver.timing || undefined,
          tokensPerSecond: ver.tokens_per_second || undefined,
          error: !!ver.error
        };
        return {
          content: ver.content,
          reasoning: ver.reasoning || undefined,
          createdAt: ver.created_at,
          metadata: {
            ...metadata,
            ...parseJson(ver.metadata, {})
          }
        };
      });

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
      if (msg.speaker_id) result.speakerId = msg.speaker_id;
      const choices = parseJson(msg.choices, []);
      if (Array.isArray(choices) && choices.length) result.choices = choices.map(String);
      const props = parseJson(msg.props, []);
      if (Array.isArray(props) && props.length) result.props = props;
      const storyTurn = parseJson(msg.story_turn, null);
      if (storyTurn) result.storyTurn = storyTurn;
      if (msg.active_version != null) result.activeVersion = msg.active_version;
      result.metadata = parseJson(msg.metadata, undefined);
      result.sources = parseJson(msg.sources, []);
      result.searchMeta = parseJson(msg.search_meta, null);
      result.agentSteps = parseJson(msg.agent_steps, []);
      result.ragDocuments = parseJson(msg.rag_documents, []);
      result.slides = parseJson(msg.slides, []);
      result.workContext = parseJson(msg.work_context, null);
      result.filesCreated = parseJson(msg.files_created, []);
      result.ttsAudio = parseJson(msg.tts_audio, undefined);
      result.artifact = parseJson(msg.artifact, null);
      const artifacts = parseJson(msg.artifacts, null);
      if (Array.isArray(artifacts) && artifacts.length) result.artifacts = artifacts;
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
      codeAgent: parseJson(chat.code_agent, null),
      homeRuntime: parseJson(chat.home_runtime, undefined),
      projectId: chat.project_id || null,
      workspace: parseJson(chat.workspace, null),
      composerMode: chat.composer_mode || null,
      searchMode: chat.search_mode || null,
      reasoningLevel: chat.reasoning_level || null,
      modelSelection: parseJson(chat.model_selection, null),
      pendingPrompts: parseJson(chat.pending_prompts, []),
      characterId: chat.character_id || null,
      worldId: chat.world_id || null,
      personaId: chat.persona_id || null,
      greetingIndex: chat.greeting_index != null ? chat.greeting_index : 0,
      roleplay: parseJson(chat.roleplay, null),
      origin: chat.origin || undefined,
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

export function loadAllCodeProjects() {
  const database = getDb();
  return database.prepare('SELECT * FROM code_projects ORDER BY updated_at DESC').all().map(p => ({
    id: p.id,
    rootPath: p.root_path,
    rootName: p.root_name,
    icon: p.icon || null,
    createdAt: p.created_at,
    updatedAt: p.updated_at
  }));
}

export function saveCodeProject(project) {
  const database = getDb();
  database.prepare(`
    INSERT INTO code_projects (id, root_path, root_name, icon, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      root_path = excluded.root_path,
      root_name = excluded.root_name,
      icon = excluded.icon,
      updated_at = excluded.updated_at
  `).run(
    project.id,
    project.rootPath,
    project.rootName,
    project.icon || null,
    project.createdAt || Date.now(),
    project.updatedAt || Date.now()
  );
}

// The renderer deletes a project's conversations explicitly (codeStore
// .deleteProject); this only drops the row. Nulling project_id here used to
// orphan every conversation into an unreachable, unsendable state.
export function deleteCodeProject(projectId) {
  const database = getDb();
  database.prepare('DELETE FROM code_projects WHERE id = ?').run(projectId);
}

// --- Roleplay: characters & personas ---
// The full card lives in `data` (JSON) so new spec fields never need a schema
// change; the columns exist for listing and ordering.

export function loadAllCharacters() {
  const database = getDb();
  return database.prepare('SELECT * FROM characters ORDER BY updated_at DESC').all().map(row => ({
    ...(parseJson(row.data, {}) || {}),
    id: row.id,
    name: row.name || parseJson(row.data, {})?.name || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

export function saveCharacter(character) {
  if (!character?.id) return;
  const database = getDb();
  database.prepare(`
    INSERT INTO characters (id, name, created_at, updated_at, data)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      updated_at = excluded.updated_at,
      data = excluded.data
  `).run(
    character.id,
    character.name || '',
    character.createdAt || Date.now(),
    character.updatedAt || Date.now(),
    stringifyJson(character)
  );
}

export function deleteCharacter(characterId) {
  const database = getDb();
  database.prepare('DELETE FROM characters WHERE id = ?').run(characterId);
}

export function loadAllPersonas() {
  const database = getDb();
  return database.prepare('SELECT * FROM personas ORDER BY updated_at DESC').all().map(row => ({
    ...(parseJson(row.data, {}) || {}),
    id: row.id,
    name: row.name || parseJson(row.data, {})?.name || '',
    isDefault: !!row.is_default,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

export function savePersona(persona) {
  if (!persona?.id) return;
  const database = getDb();
  database.prepare(`
    INSERT INTO personas (id, name, is_default, created_at, updated_at, data)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      is_default = excluded.is_default,
      updated_at = excluded.updated_at,
      data = excluded.data
  `).run(
    persona.id,
    persona.name || '',
    persona.isDefault ? 1 : 0,
    persona.createdAt || Date.now(),
    persona.updatedAt || Date.now(),
    stringifyJson(persona)
  );
}

export function deletePersona(personaId) {
  const database = getDb();
  database.prepare('DELETE FROM personas WHERE id = ?').run(personaId);
}

export function loadAllWorlds() {
  const database = getDb();
  return database.prepare('SELECT * FROM worlds ORDER BY updated_at DESC').all().map(row => ({
    ...(parseJson(row.data, {}) || {}),
    id: row.id,
    name: row.name || parseJson(row.data, {})?.name || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

export function saveWorld(world) {
  if (!world?.id) return;
  const database = getDb();
  database.prepare(`
    INSERT INTO worlds (id, name, created_at, updated_at, data)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      updated_at = excluded.updated_at,
      data = excluded.data
  `).run(
    world.id,
    world.name || '',
    world.createdAt || Date.now(),
    world.updatedAt || Date.now(),
    stringifyJson(world)
  );
}

export function deleteWorld(worldId) {
  const database = getDb();
  database.prepare('DELETE FROM worlds WHERE id = ?').run(worldId);
}

export function deleteChat(chatId) {
  const database = getDb();
  database.prepare('DELETE FROM chats WHERE id = ?').run(chatId);
  // The file itself outlives the chat (it may be attached elsewhere, and the
  // Files screen still lists it), but this chat no longer holds a reference —
  // which is what makes an unreferenced file "unused" for cleanup.
  database.prepare('DELETE FROM file_refs WHERE chat_id = ?').run(chatId);
  for (const id of chatMessageIds.get(chatId) ?? []) messageFingerprints.delete(`${chatId}\0${id}`);
  chatMessageIds.delete(chatId);
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
  try { transaction(); }
  catch (error) { messageFingerprints.clear(); chatMessageIds.clear(); throw error; }
  return migrated;
}

export function closeDb() {
  messageFingerprints.clear();
  chatMessageIds.clear();
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

export function deleteRagDocumentDb(docId) {
  const database = getDb();
  return database.prepare('DELETE FROM rag_documents WHERE id = ?').run(docId).changes > 0;
}

export function deleteRagDocumentsByChat(chatId) {
  const database = getDb();
  return database.prepare('DELETE FROM rag_documents WHERE chat_id = ?').run(chatId).changes;
}

// --- Global file registry ---
// One row per sha256 (`files`), one row per (file, chat, message) use
// (`file_refs`). Rows survive the chats that reference them: a file is only
// "unused" when nothing links it and it is not pinned.

const FILE_COLUMNS = 'hash, name, mime, bytes, kind, stored_path, created_at, last_used_at, extract_status, extracted_chars, rag_doc_id, pinned, origin, spec_path, version';

function fileRecordFromRow(row) {
  return {
    hash: row.hash,
    name: row.name,
    mime: row.mime || null,
    bytes: row.bytes || 0,
    kind: row.kind || 'file',
    storedPath: row.stored_path || null,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    extractStatus: row.extract_status || 'pending',
    extractedChars: row.extracted_chars || 0,
    ragDocId: row.rag_doc_id || null,
    pinned: !!row.pinned,
    origin: row.origin || 'upload',
    specPath: row.spec_path || null,
    version: row.version || 1
  };
}

function fileRefFromRow(row) {
  return { hash: row.hash, chatId: row.chat_id, messageId: row.message_id || '' };
}

/**
 * Insert or refresh a file. Identity (name, mime, size, kind, path) and the
 * last use time follow the caller; everything the store learned on its own —
 * when it first arrived, pinning, extraction state, origin, spec version —
 * is only written on the first insert and never overwritten.
 */
export function upsertFileRecord(record) {
  if (!record?.hash) return null;
  const database = getDb();
  const now = Date.now();
  database.prepare(`
    INSERT INTO files (${FILE_COLUMNS})
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(hash) DO UPDATE SET
      name = excluded.name,
      mime = excluded.mime,
      bytes = excluded.bytes,
      kind = excluded.kind,
      stored_path = excluded.stored_path,
      last_used_at = excluded.last_used_at
  `).run(
    record.hash,
    record.name || '',
    record.mime || null,
    record.bytes || 0,
    record.kind || 'file',
    record.storedPath || null,
    record.createdAt || now,
    record.lastUsedAt || now,
    record.extractStatus || 'pending',
    record.extractedChars || 0,
    record.ragDocId || null,
    record.pinned ? 1 : 0,
    record.origin || 'upload',
    record.specPath || null,
    record.version || 1
  );
  return getFileRecord(record.hash);
}

export function getFileRecord(hash) {
  const row = getDb().prepare('SELECT * FROM files WHERE hash = ?').get(hash);
  return row ? fileRecordFromRow(row) : null;
}

/** The file a RAG document came from; null for text that arrived without one. */
export function getFileRecordByDocId(docId) {
  if (!docId) return null;
  const row = getDb().prepare('SELECT * FROM files WHERE rag_doc_id = ?').get(docId);
  return row ? fileRecordFromRow(row) : null;
}

export function listFileRecords() {
  return getDb().prepare('SELECT * FROM files ORDER BY last_used_at DESC, created_at DESC').all().map(fileRecordFromRow);
}

/** Links a file to a chat message and marks it as used. */
export function linkFileRef({ hash, chatId, messageId = '' } = {}) {
  const database = getDb();
  const linked = database.prepare('INSERT OR IGNORE INTO file_refs (hash, chat_id, message_id) VALUES (?, ?, ?)')
    .run(hash, chatId, messageId || '').changes > 0;
  database.prepare('UPDATE files SET last_used_at = ? WHERE hash = ?').run(Date.now(), hash);
  return linked;
}

export function unlinkFileRef({ hash, chatId, messageId = '' } = {}) {
  return getDb().prepare('DELETE FROM file_refs WHERE hash = ? AND chat_id = ? AND message_id = ?')
    .run(hash, chatId, messageId || '').changes > 0;
}

/** Drops every file a message carried (message edits and deletes). */
export function unlinkFileRefsForMessage(messageId) {
  return getDb().prepare('DELETE FROM file_refs WHERE message_id = ?').run(messageId).changes;
}

export function listFileRefs(hash) {
  return getDb().prepare('SELECT * FROM file_refs WHERE hash = ? ORDER BY chat_id ASC, message_id ASC').all(hash).map(fileRefFromRow);
}

/** Partial update: fields left undefined keep their stored value. */
export function setFileStatus(hash, status = {}) {
  const sets = [];
  const params = [];
  if (status.extractStatus !== undefined) { sets.push('extract_status = ?'); params.push(status.extractStatus); }
  if (status.extractedChars !== undefined) { sets.push('extracted_chars = ?'); params.push(status.extractedChars); }
  if (status.ragDocId !== undefined) { sets.push('rag_doc_id = ?'); params.push(status.ragDocId); }
  if (!sets.length) return getFileRecord(hash);
  params.push(hash);
  getDb().prepare(`UPDATE files SET ${sets.join(', ')} WHERE hash = ?`).run(...params);
  return getFileRecord(hash);
}

export function setFilePinned(hash, pinned) {
  getDb().prepare('UPDATE files SET pinned = ? WHERE hash = ?').run(pinned ? 1 : 0, hash);
  return getFileRecord(hash);
}

/** Removes the file; its `file_refs` rows go with it (ON DELETE CASCADE). */
export function deleteFileRecord(hash) {
  return getDb().prepare('DELETE FROM files WHERE hash = ?').run(hash).changes > 0;
}

/** Unused = never pinned and referenced by no chat. */
export function fileStoreStats() {
  const database = getDb();
  const total = database.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM files').get();
  const unused = database.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(f.bytes), 0) AS bytes
    FROM files f
    WHERE f.pinned = 0 AND NOT EXISTS (SELECT 1 FROM file_refs r WHERE r.hash = f.hash)
  `).get();
  return { count: total.count, bytes: total.bytes, unusedCount: unused.count, unusedBytes: unused.bytes };
}

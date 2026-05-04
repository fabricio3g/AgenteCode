import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronPath = require.resolve('electron');
let sqliteUnavailable = '';

let tempDir;
let chatDb;

function getDatabase() {
  try {
    const Database = require('better-sqlite3');
    const probe = new Database(':memory:');
    probe.close();
    return Database;
  } catch (error) {
    sqliteUnavailable = String(error?.message || error || 'better-sqlite3 unavailable');
    return null;
  }
}

function installElectronMock(root) {
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      app: {
        isPackaged: false,
        getPath(name) {
          if (name === 'home') return path.join(root, 'home');
          if (name === 'appData') return path.join(root, 'appData');
          if (name === 'exe') return path.join(root, 'app.exe');
          return path.join(root, name);
        }
      }
    }
  };
}

async function loadChatDb() {
  if (!chatDb) {
    chatDb = await import('../../main/chat-db.ts');
  }
  return chatDb;
}

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatealm-chat-db-'));
  process.env.TALAMOLM_HOME = tempDir;
  installElectronMock(tempDir);
  const mod = await loadChatDb();
  mod.closeDb();
});

afterEach(async () => {
  const mod = await loadChatDb();
  mod.closeDb();
  delete process.env.TALAMOLM_HOME;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

describe('chat-db process persistence', () => {
  it('round-trips agent steps, search metadata, sources, artifacts, and rich version metadata', async (t) => {
    if (!getDatabase()) {
      t.skip(`better-sqlite3 is unavailable in this Node runtime: ${sqliteUnavailable}`);
      return;
    }
    const { saveChatSession, loadAllChats } = await loadChatDb();
    const session = {
      id: 'chat-agent-process',
      title: 'Agent process',
      createdAt: 1000,
      updatedAt: 2000,
      folderId: null,
      draft: '',
      contextMode: 'chat',
      messages: [{
        id: 'msg-agent',
        role: 'assistant',
        content: 'Gathered evidence from search.',
        reasoning: 'Checked sources.',
        createdAt: 1500,
        model: 'test-model',
        done: true,
        status: 'idle',
        searchMode: 'search',
        mode: 'agent',
        activeVersion: 0,
        metadata: {
          modelName: 'test-model',
          warning: 'Agent encountered a loop and returned only gathered evidence.',
          outcome: 'stopped',
          stopReason: 'loop',
          currentActivity: 'stopped',
          activityLabel: 'Agent stopped'
        },
        sources: [{
          title: 'Example source',
          url: 'https://example.com/source',
          snippet: 'A useful snippet'
        }],
        searchMeta: {
          searchRequested: true,
          searchSucceeded: true,
          contextAvailable: true,
          sourceCount: 1,
          providerUsed: 'duckduckgo',
          stopReason: 'loop'
        },
        agentSteps: [{
          id: 'step-search',
          type: 'searching',
          label: 'Searching the web',
          status: 'done',
          detail: 'Found 1 source'
        }],
        artifact: {
          title: 'Evidence file',
          files: { 'evidence.md': '# Evidence' },
          previewHtml: '<h1>Evidence</h1>'
        },
        ragDocuments: [{ id: 'doc-1', name: 'Doc', source: 'upload' }],
        slides: [{ title: 'Slide 1', bullets: ['A'] }],
        workContext: { rootName: 'Workspace', fileCount: 2, indexedCount: 1 },
        filesCreated: [{ path: 'evidence.md', name: 'evidence.md' }],
        versions: [{
          content: 'Gathered evidence from search.',
          reasoning: 'Checked sources.',
          createdAt: 1500,
          metadata: {
            modelName: 'test-model',
            warning: 'Agent encountered a loop and returned only gathered evidence.',
            outcome: 'stopped',
            stopReason: 'loop',
            currentActivity: 'stopped',
            activityLabel: 'Agent stopped',
            tokens: 4,
            timing: 1.2,
            tokensPerSecond: 3.3
          }
        }]
      }]
    };

    saveChatSession(session);

    const [loaded] = loadAllChats();
    const [message] = loaded.messages;
    assert.strictEqual(message.metadata.stopReason, 'loop');
    assert.strictEqual(message.metadata.outcome, 'stopped');
    assert.strictEqual(message.sources[0].url, 'https://example.com/source');
    assert.strictEqual(message.searchMeta.providerUsed, 'duckduckgo');
    assert.strictEqual(message.searchMeta.stopReason, 'loop');
    assert.strictEqual(message.agentSteps[0].label, 'Searching the web');
    assert.strictEqual(message.artifact.files['evidence.md'], '# Evidence');
    assert.strictEqual(message.ragDocuments[0].id, 'doc-1');
    assert.strictEqual(message.slides[0].title, 'Slide 1');
    assert.strictEqual(message.workContext.rootName, 'Workspace');
    assert.strictEqual(message.filesCreated[0].path, 'evidence.md');
    assert.strictEqual(message.versions[0].metadata.warning, 'Agent encountered a loop and returned only gathered evidence.');
    assert.strictEqual(message.versions[0].metadata.currentActivity, 'stopped');
  });

  it('migrates old message rows without process columns and loads safe defaults', async (t) => {
    const Database = getDatabase();
    if (!Database) {
      t.skip(`better-sqlite3 is unavailable in this Node runtime: ${sqliteUnavailable}`);
      return;
    }
    const dbPath = path.join(tempDir, 'cache', 'chat-history.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const oldDb = new Database(dbPath);
    oldDb.exec(`
      CREATE TABLE chats (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        folder_id TEXT,
        draft TEXT NOT NULL DEFAULT '',
        context_mode TEXT DEFAULT 'chat',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
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
        artifact TEXT,
        folder_id TEXT
      );
      CREATE TABLE attachments (
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
        error TEXT
      );
      CREATE TABLE message_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        reasoning TEXT,
        created_at INTEGER NOT NULL,
        model_name TEXT,
        tokens INTEGER,
        timing REAL,
        tokens_per_second REAL,
        error INTEGER DEFAULT 0
      );
      CREATE TABLE folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        parent_id TEXT,
        created_at INTEGER NOT NULL
      );
    `);
    oldDb.prepare('INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run('old-chat', 'Old chat', 100, 200);
    oldDb.prepare('INSERT INTO messages (id, chat_id, role, content, created_at, done, status) VALUES (?, ?, ?, ?, ?, ?, ?)').run('old-msg', 'old-chat', 'assistant', 'Old answer', 150, 1, 'idle');
    oldDb.close();

    const { loadAllChats } = await loadChatDb();
    const [loaded] = loadAllChats();
    const [message] = loaded.messages;

    assert.strictEqual(message.content, 'Old answer');
    assert.deepStrictEqual(message.sources, []);
    assert.strictEqual(message.searchMeta, null);
    assert.deepStrictEqual(message.agentSteps, []);
    assert.deepStrictEqual(message.ragDocuments, []);
    assert.deepStrictEqual(message.slides, []);
    assert.strictEqual(message.workContext, null);
    assert.deepStrictEqual(message.filesCreated, []);
  });
});

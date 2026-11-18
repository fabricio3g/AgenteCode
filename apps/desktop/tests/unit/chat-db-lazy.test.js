import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import Database from '../../main/sqlite.ts';

const require = createRequire(import.meta.url);
const electronPath = require.resolve('electron');
let sqliteUnavailable = '';

let tempDir;
let chatDb;

function getDatabase() {
  try {
    const probe = new Database(':memory:');
    probe.close();
    return Database;
  } catch (error) {
    sqliteUnavailable = String(error?.message || error || 'node:sqlite unavailable');
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

const skip = (t) => { if (getDatabase()) return false; t.skip(`node:sqlite unavailable: ${sqliteUnavailable}`); return true; };
const turn = (id, content, extra = {}) => ({ id, role: 'assistant', content, createdAt: Number(id.replace(/\D/g, '')) || 1, done: true, agentSteps: [{ id: `${id}-s`, type: 'tool', label: 'read_file', toolName: 'read_file', status: 'done', output: 'x'.repeat(500), fileChanges: [{ path: 'docs/plan.md', kind: 'added' }] }], ...extra });

describe('chat-db lazy Code transcripts', () => {
  it('loads Code chats without their transcript and everything else in full', async (t) => {
    if (skip(t)) return;
    const { saveChatSession, loadAllChats, loadChatMessages } = await loadChatDb();
    saveChatSession({ id: 'code', title: 'Code', contextMode: 'code', createdAt: 1, updatedAt: 2, messages: [turn('m1', 'one'), turn('m2', 'two')] });
    saveChatSession({ id: 'legacy', title: 'Legacy work', contextMode: 'work', createdAt: 1, updatedAt: 1, messages: [turn('m3', 'three')] });
    saveChatSession({ id: 'home', title: 'Home', contextMode: 'home', createdAt: 1, updatedAt: 3, messages: [{ id: 'h1', role: 'user', content: 'hi', createdAt: 1 }] });
    const byId = Object.fromEntries(loadAllChats().map((chat) => [chat.id, chat]));
    assert.strictEqual(byId.code.messagesLoaded, false);
    assert.deepStrictEqual(byId.code.messages, []);
    assert.strictEqual(byId.legacy.messagesLoaded, false);
    assert.strictEqual(byId.home.messagesLoaded, undefined);
    assert.strictEqual(byId.home.messages[0].content, 'hi');
    const full = loadChatMessages('code');
    assert.deepStrictEqual(full.map((m) => m.content), ['one', 'two']);
    assert.strictEqual(full[0].agentSteps[0].output.length, 500);
  });

  it('never deletes a transcript when a row-only save arrives without messages', async (t) => {
    if (skip(t)) return;
    const { saveChatSession, loadChatMessages, loadAllChats } = await loadChatDb();
    saveChatSession({ id: 'code', title: 'Before', contextMode: 'code', createdAt: 1, updatedAt: 1, messages: [turn('m1', 'one'), turn('m2', 'two')] });
    // What the renderer sends for an unloaded chat: the row, no `messages`.
    saveChatSession({ id: 'code', title: 'Renamed', contextMode: 'code', createdAt: 1, updatedAt: 5, messagesLoaded: false });
    assert.strictEqual(loadAllChats().find((chat) => chat.id === 'code').title, 'Renamed');
    assert.deepStrictEqual(loadChatMessages('code').map((m) => m.id), ['m1', 'm2']);
    // An explicit empty list still means "the transcript is empty now".
    saveChatSession({ id: 'code', title: 'Cleared', contextMode: 'code', createdAt: 1, updatedAt: 6, messages: [] });
    assert.deepStrictEqual(loadChatMessages('code'), []);
  });

  it('searches unloaded transcripts with LIKE wildcards escaped', async (t) => {
    if (skip(t)) return;
    const { saveChatSession, searchChatMessages } = await loadChatDb();
    saveChatSession({ id: 'a', title: 'A', contextMode: 'code', createdAt: 1, updatedAt: 1, messages: [turn('m1', 'Nothing here'), turn('m2', 'The Renderer re-parses 100% of it')] });
    saveChatSession({ id: 'b', title: 'B', contextMode: 'code', createdAt: 1, updatedAt: 1, messages: [turn('m3', 'rendererXv2 only')] });
    assert.deepStrictEqual(searchChatMessages('renderer', ['a', 'b']).map((hit) => [hit.chatId, hit.messageId]), [['a', 'm2'], ['b', 'm3']]);
    assert.deepStrictEqual(searchChatMessages('100%', ['a', 'b']).map((hit) => hit.chatId), ['a']);
    // Unescaped, `_` would match the X.
    assert.deepStrictEqual(searchChatMessages('renderer_v2', ['a', 'b']), []);
    assert.deepStrictEqual(searchChatMessages('  ', ['a']), []);
  });

  it('reads only file facts for the Files screen', async (t) => {
    if (skip(t)) return;
    const { saveChatSession, loadChatFileFacts } = await loadChatDb();
    saveChatSession({ id: 'code', title: 'Code', contextMode: 'code', createdAt: 1, updatedAt: 1, messages: [turn('m1', 'one'), { id: 'm2', role: 'user', content: 'no files', createdAt: 2 }] });
    const facts = loadChatFileFacts(['code']);
    assert.strictEqual(facts.code.length, 1);
    assert.deepStrictEqual(facts.code[0].agentSteps, [{ id: 'm1-s', fileChanges: [{ path: 'docs/plan.md', kind: 'added' }] }]);
    assert.strictEqual('output' in facts.code[0].agentSteps[0], false);
  });
});

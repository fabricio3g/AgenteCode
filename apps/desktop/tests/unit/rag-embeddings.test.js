import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, before, describe, it } from 'node:test';

import { clearEmbeddingCache, getEmbeddings } from '../../main/embedding-client.ts';
import { setEmbeddingStatus } from '../../main/embedding-state.ts';
import { VectorStore } from '../../main/vector-store.ts';

const require = createRequire(import.meta.url);
const electronPath = require.resolve('electron');

let tempDir;
let server;
let port;
let serverDim = 8;
let serverModelTag = 'model-a';
let maxBatchAllowed = 16;
let failSingleText = '';

function makeVector(seed, dim) {
  const vec = new Array(dim).fill(0);
  vec[seed % dim] = 1;
  return vec;
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

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-embeddings-'));
  process.env.TALAMOLM_HOME = tempDir;
  installElectronMock(tempDir);

  server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/embeddings') {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const inputs = Array.isArray(body.input) ? body.input : [body.input];

    if (inputs.length > maxBatchAllowed) {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'payload too large' }));
      return;
    }

    if (failSingleText && inputs.includes(failSingleText)) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad item' }));
      return;
    }

    const data = inputs.map((text, index) => ({
      index,
      embedding: makeVector(
        String(text).split('').reduce((acc, ch) => acc + ch.charCodeAt(0), serverModelTag === 'model-b' ? 3 : 0),
        serverDim
      )
    }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  setEmbeddingStatus({ state: 'idle', port: null, model_id: null, model_path: null, dimension: null });
  clearEmbeddingCache();
  server?.closeAllConnections?.();
  server?.close?.();
  try {
    const { chatDatabase } = await import('../../main/chat-db-client.ts');
    await chatDatabase.close();
  } catch {}
  try {
    const { closeDb } = await import('../../main/chat-db.ts');
    closeDb();
  } catch {}
  delete process.env.TALAMOLM_HOME;
  if (tempDir) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

describe('RAG embedding batching and model-space isolation', () => {
  it('splits oversized batches on HTTP 413 so 300 chunks embed completely (#21)', async () => {
    clearEmbeddingCache();
    maxBatchAllowed = 16;
    failSingleText = '';
    serverDim = 8;
    serverModelTag = 'model-a';
    setEmbeddingStatus({ state: 'ready', port, model_id: 'model-a.gguf', model_path: '/models/model-a.gguf', dimension: null });

    const texts = Array.from({ length: 300 }, (_, i) => `chunk payload number ${i}`);
    const vectors = await getEmbeddings(texts, { batchSize: 64, concurrency: 2 });

    assert.equal(vectors.length, 300);
    assert.ok(vectors.every((v) => v instanceof Float32Array && v.length === 8));
  });

  it('keeps successful vectors when one item fails and persists valid rows to VectorStore (#21)', async () => {
    clearEmbeddingCache();
    maxBatchAllowed = 32;
    failSingleText = 'poison-chunk';
    serverDim = 8;
    setEmbeddingStatus({ state: 'ready', port, model_id: 'model-a.gguf', model_path: '/models/model-a.gguf', dimension: null });

    const texts = ['alpha-chunk', 'poison-chunk', 'beta-chunk'];
    const vectors = await getEmbeddings(texts, { batchSize: 8 });
    assert.ok(vectors[0] instanceof Float32Array);
    assert.equal(vectors[1], null);
    assert.ok(vectors[2] instanceof Float32Array);

    const store = new VectorStore();
    await store.init(path.join(tempDir, 'lancedb-partial'));
    const chunks = texts.map((text, index) => ({ id: `docp-${index}`, text, index, heading: 'H1', line_start: 1, line_end: 1 }));
    const space = { modelId: '/models/model-a.gguf', dimension: 8, version: 1 };
    const written = await store.addChunks('chat-p', { id: 'doc-p', source: 'p.md', file_type: 'markdown' }, chunks, vectors, space);
    assert.equal(written, true);
    assert.equal(await store.countRows(space), 2);
  });

  it('isolates vector spaces and query caches across dimension changes and same-dimension model changes (#22)', async () => {
    const rag = await import('../../main/rag-engine.ts');
    clearEmbeddingCache();
    rag.clearQueryEmbeddingCache();
    maxBatchAllowed = 32;
    failSingleText = '';

    // 1. Index 211 chunks (> 200 fast path) under 8-dim model-a.
    serverDim = 8;
    serverModelTag = 'model-a';
    setEmbeddingStatus({ state: 'ready', port, model_id: 'model-a.gguf', model_path: '/models/model-a.gguf', dimension: null });

    const bigText = Array.from({ length: 215 }, (_, i) => `## Section ${i}\n\nQuarterly invoice reconciliation item ${i}.`).join('\n\n');
    const doc = await rag.ingestText({ source: 'ledger.md', text: bigText, chat_id: 'model-switch-chat', file_type: 'markdown', chunk_size: 80 });
    assert.equal(doc.embedding_dim, 8);
    assert.equal(doc.embedding_model_id, '/models/model-a.gguf');

    const firstRes = await rag.queryDocuments({ query: 'quarterly invoice', chat_id: 'model-switch-chat', top_k: 3 });
    assert.equal(firstRes.retrieval, 'hybrid');

    // 2. Switch to 12-dim model-c WITHOUT clearing caches manually: query cache must NOT reuse 8-dim vector,
    //    and search must fall back cleanly to keyword without throwing a LanceDB dimension mismatch.
    serverDim = 12;
    serverModelTag = 'model-c';
    setEmbeddingStatus({ state: 'ready', port, model_id: 'model-c.gguf', model_path: '/models/model-c.gguf', dimension: null });

    const switchedDimRes = await rag.queryDocuments({ query: 'quarterly invoice', chat_id: 'model-switch-chat', top_k: 3 });
    assert.equal(switchedDimRes.retrieval, 'keyword');
    assert.ok(switchedDimRes.results.length > 0);
    assert.match(switchedDimRes.notice || '', /keyword search/i);

    // 3. Switch to same-dimension (8-dim) but different model-b: must also isolate space instead of mixing model-a vectors.
    serverDim = 8;
    serverModelTag = 'model-b';
    setEmbeddingStatus({ state: 'ready', port, model_id: 'model-b.gguf', model_path: '/models/model-b.gguf', dimension: null });

    const sameDimDifferentModel = await rag.queryDocuments({ query: 'quarterly invoice', chat_id: 'model-switch-chat', top_k: 3 });
    assert.equal(sameDimDifferentModel.retrieval, 'keyword');
    assert.ok(sameDimDifferentModel.results.length > 0);
  });
});

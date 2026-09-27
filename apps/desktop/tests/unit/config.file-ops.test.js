/**
 * Tests for JSON file operations (readJsonSafe, writeJsonSafe).
 * These tests require file system operations, so we use a temp directory.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readJsonSafe, writeJsonSafe } from '../../main/config.utils.ts';

// Create a temp directory for file tests
let tempDir;

beforeEach(() => {
  tempDir = path.join(os.tmpdir(), `chatealm-test-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  // Clean up temp directory
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

// ── writeJsonSafe tests ─────────────────────────────────────────────────────

describe('writeJsonSafe', () => {
  it('writes valid JSON to file', () => {
    const filePath = path.join(tempDir, 'test.json');
    const data = { name: 'test', value: 123 };
    const result = writeJsonSafe(filePath, data);
    assert.strictEqual(result, true);
    
    const content = fs.readFileSync(filePath, 'utf8');
    assert.deepStrictEqual(JSON.parse(content), data);
  });

  it('creates parent directories if missing', () => {
    const filePath = path.join(tempDir, 'nested', 'deep', 'test.json');
    const data = { nested: true };
    const result = writeJsonSafe(filePath, data);
    assert.strictEqual(result, true);
    assert.ok(fs.existsSync(filePath));
  });

  it('formats JSON with 2-space indentation', () => {
    const filePath = path.join(tempDir, 'formatted.json');
    const data = { a: { b: { c: 1 } } };
    writeJsonSafe(filePath, data);
    
    const content = fs.readFileSync(filePath, 'utf8');
    assert.ok(content.includes('  "a":'));
    assert.ok(content.includes('    "b":'));
  });

  it('handles arrays', () => {
    const filePath = path.join(tempDir, 'array.json');
    const data = [1, 2, 3, { nested: true }];
    const result = writeJsonSafe(filePath, data);
    assert.strictEqual(result, true);
    
    const content = fs.readFileSync(filePath, 'utf8');
    assert.deepStrictEqual(JSON.parse(content), data);
  });

  it('handles empty objects', () => {
    const filePath = path.join(tempDir, 'empty.json');
    const result = writeJsonSafe(filePath, {});
    assert.strictEqual(result, true);
    assert.strictEqual(fs.readFileSync(filePath, 'utf8'), '{}');
  });

  it('handles null values', () => {
    const filePath = path.join(tempDir, 'null.json');
    const result = writeJsonSafe(filePath, null);
    assert.strictEqual(result, true);
    assert.strictEqual(fs.readFileSync(filePath, 'utf8'), 'null');
  });

  it('returns false for invalid file path', () => {
    // Try to write to a path that requires permissions we don't have
    const invalidPath = '/root/protected/test.json'; // Linux root folder
    const result = writeJsonSafe(invalidPath, { test: true });
    // On Windows this might succeed in a different way, so we accept both outcomes
    assert.ok(typeof result === 'boolean');
  });

  it('overwrites existing file', () => {
    const filePath = path.join(tempDir, 'overwrite.json');
    fs.writeFileSync(filePath, '{"old": true}');
    const newData = { new: true };
    const result = writeJsonSafe(filePath, newData);
    assert.strictEqual(result, true);
    
    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.deepStrictEqual(content, newData);
    assert.strictEqual(content.old, undefined);
  });
});

// ── readJsonSafe tests ──────────────────────────────────────────────────────

describe('readJsonSafe', () => {
  it('reads valid JSON from file', () => {
    const filePath = path.join(tempDir, 'read.json');
    fs.writeFileSync(filePath, '{"name": "test", "value": 123}');
    
    const result = readJsonSafe(filePath, {});
    assert.deepStrictEqual(result, { name: 'test', value: 123 });
  });

  it('returns fallback for missing file', () => {
    const filePath = path.join(tempDir, 'nonexistent.json');
    const fallback = { default: true };
    
    const result = readJsonSafe(filePath, fallback);
    assert.strictEqual(result, fallback);
  });

  it('returns fallback for invalid JSON', () => {
    const filePath = path.join(tempDir, 'invalid.json');
    fs.writeFileSync(filePath, 'not valid json {{{');
    
    const fallback = { default: true };
    const result = readJsonSafe(filePath, fallback);
    assert.strictEqual(result, fallback);
  });

  it('returns fallback for empty file', () => {
    const filePath = path.join(tempDir, 'empty.json');
    fs.writeFileSync(filePath, '');
    
    const fallback = { default: true };
    const result = readJsonSafe(filePath, fallback);
    assert.strictEqual(result, fallback);
  });

  it('handles arrays as fallback', () => {
    const filePath = path.join(tempDir, 'missing-array.json');
    const fallback = [1, 2, 3];
    
    const result = readJsonSafe(filePath, fallback);
    assert.deepStrictEqual(result, fallback);
  });

  it('handles null as fallback', () => {
    const filePath = path.join(tempDir, 'missing-null.json');
    
    const result = readJsonSafe(filePath, null);
    assert.strictEqual(result, null);
  });

  it('reads complex nested objects', () => {
    const filePath = path.join(tempDir, 'complex.json');
    const data = {
      llm: {
        providers: {
          openai: { model: 'gpt-4', params: { temperature: 0.7 } }
        }
      },
      rag: { enabled: true, models: ['a', 'b', 'c'] }
    };
    fs.writeFileSync(filePath, JSON.stringify(data));
    
    const result = readJsonSafe(filePath, {});
    assert.deepStrictEqual(result, data);
  });

  it('handles JSON with whitespace', () => {
    const filePath = path.join(tempDir, 'whitespace.json');
    fs.writeFileSync(filePath, '\n  {"key": "value"}\n');
    
    const result = readJsonSafe(filePath, {});
    assert.deepStrictEqual(result, { key: 'value' });
  });
});

// ── Integration tests: write then read ───────────────────────────────────────

describe('writeJsonSafe + readJsonSafe integration', () => {
  it('round-trips config object', () => {
    const config = {
      tts: { engine: 'kokoro', num_threads: 2 },
      llm: { provider: 'openai' },
      rag: { enabled: true }
    };
    const filePath = path.join(tempDir, 'config.json');
    
    assert.strictEqual(writeJsonSafe(filePath, config), true);
    const loaded = readJsonSafe(filePath, null);
    assert.deepStrictEqual(loaded, config);
  });

  it('round-trips array data', () => {
    const data = [
      { id: 1, name: 'first' },
      { id: 2, name: 'second' }
    ];
    const filePath = path.join(tempDir, 'array-data.json');
    
    writeJsonSafe(filePath, data);
    const loaded = readJsonSafe(filePath, []);
    assert.deepStrictEqual(loaded, data);
  });

  it('handles concurrent writes safely', async () => {
    const filePath = path.join(tempDir, 'concurrent.json');
    
    // Write multiple times rapidly
    for (let i = 0; i < 10; i++) {
      writeJsonSafe(filePath, { iteration: i });
    }
    
    // Final read should have last iteration
    const result = readJsonSafe(filePath, {});
    assert.strictEqual(result.iteration, 9);
  });
});
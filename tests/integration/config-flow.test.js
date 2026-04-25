/**
 * Integration tests for the full config flow.
 * Tests how all TypeScript modules work together.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Import all TypeScript modules
import { slugify, deepMerge, deepClone, readJsonSafe, writeJsonSafe } from '../../main/config.utils.ts';
import { getDefaultConfig, getDefaultLLMConfig, getDefaultProvider } from '../../main/config.defaults.ts';
import { migrateConfig, URL_FIXES } from '../../main/config.migrate.ts';
import { redactConfig, hasApiKey, countApiKeys } from '../../main/config.redact.ts';
import { SecretsManager, MemoryCryptoProvider } from '../../main/config.secrets.ts';

// Create temp directory for tests
let tempDir;
let configPath;
let secretsPath;
let modelsRoot;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-integration-'));
  configPath = path.join(tempDir, 'config.json');
  secretsPath = path.join(tempDir, 'secrets.json');
  modelsRoot = path.join(tempDir, 'models');
  fs.mkdirSync(modelsRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('Full Config Flow Integration', () => {
  describe('Default Config Creation', () => {
    it('creates complete default config with all sections', () => {
      const paths = { configPath, secretsPath, modelsRoot, localModelsRoot: modelsRoot };
      const config = getDefaultConfig(paths);
      
      // Verify all major sections exist
      assert.ok(config.llm, 'llm section exists');
      assert.ok(config.tts, 'tts section exists');
      assert.ok(config.stt, 'stt section exists');
      assert.ok(config.rag, 'rag section exists');
      assert.ok(config.onboarding, 'onboarding section exists');
      
      // Verify structure - providers is a Record object under llm
      assert.ok(config.llm.providers, 'llm.providers section exists');
      assert.ok(typeof config.llm.providers === 'object', 'llm.providers is object');
    });

    it('default config is valid for redaction', () => {
      const paths = { configPath, secretsPath, modelsRoot, localModelsRoot: modelsRoot };
      const config = getDefaultConfig(paths);
      
      // Should not throw
      const redacted = redactConfig(config);
      
      // No API keys in default config (all empty strings)
      assert.strictEqual(countApiKeys(redacted), 0);
    });
  });

  describe('Config Persistence', () => {
    it('writes and reads config preserving structure', () => {
      const paths = { configPath, secretsPath, modelsRoot, localModelsRoot: modelsRoot };
      const original = getDefaultConfig(paths);
      
      // Add some values
      original.llm.provider = 'test-provider';
      original.llm.providers.test = getDefaultProvider('http://localhost:1234/v1');
      
      // Write and read back
      writeJsonSafe(configPath, original);
      const read = readJsonSafe(configPath, null);
      
      assert.strictEqual(read.llm.provider, 'test-provider');
      assert.ok(read.llm.providers.test, 'test provider exists');
    });

    it('handles missing config file gracefully', () => {
      const read = readJsonSafe('/nonexistent/path.json', { fallback: true });
      assert.deepStrictEqual(read, { fallback: true });
    });
  });

  describe('Migration Flow', () => {
    it('migrates existing provider configs', () => {
      const paths = { configPath, secretsPath, modelsRoot, localModelsRoot: modelsRoot };
      
      // Create config with existing providers
      const oldConfig = {
        llm: {
          providers: {
            openai: {
              base_url: 'https://api.openai.com/v1',
              model: 'gpt-4o-mini'  // legacy default model
            }
          }
        }
      };
      
      const result = migrateConfig(oldConfig, modelsRoot);
      
      // Should have llm section with providers
      assert.ok(result.config.llm, 'llm section exists');
      assert.ok(result.config.llm.providers, 'llm.providers exists');
      assert.strictEqual(result.dirty, true, 'marked as dirty due to model clear');
    });

    it('applies URL fixes during migration', () => {
      const paths = { configPath, secretsPath, modelsRoot, localModelsRoot: modelsRoot };
      
      // Config with old URL that needs fixing
      const oldConfig = {
        llm: {
          providers: {
            openrouter: {
              base_url: 'https://openrouter.ai/api'  // old URL
            }
          }
        }
      };
      
      const result = migrateConfig(oldConfig, modelsRoot);
      
      // URL should be fixed
      const provider = result.config.llm?.providers?.openrouter;
      assert.strictEqual(provider?.base_url, 'https://openrouter.ai/api/v1', 'URL fixed');
    });
  });

  describe('Secrets Management Flow', () => {
    it('extracts, saves, and injects API keys', () => {
      const crypto = new MemoryCryptoProvider(true);
      const paths = { configPath, secretsPath, modelsRoot, localModelsRoot: modelsRoot };
      const manager = new SecretsManager(crypto, paths);
      
      // Create config with API keys
      const config = getDefaultConfig(paths);
      config.llm.providers.openai.api_key = 'sk-test-key-12345';
      
      // Extract and save to secrets
      manager.saveApiKeysToSecrets(config);
      
      // API key should be cleared in config
      assert.strictEqual(config.llm.providers.openai.api_key, '');
      
      // Secrets file should exist
      assert.ok(fs.existsSync(secretsPath), 'secrets file created');
      
      // Inject back
      manager.injectApiKeysFromSecrets(config);
      
      // API key should be restored
      assert.strictEqual(config.llm.providers.openai.api_key, 'sk-test-key-12345');
    });

    it('handles multiple providers with API keys', () => {
      const crypto = new MemoryCryptoProvider(true);
      const paths = { configPath, secretsPath, modelsRoot, localModelsRoot: modelsRoot };
      const manager = new SecretsManager(crypto, paths);
      
      const config = getDefaultConfig(paths);
      config.llm.providers.openai.api_key = 'sk-openai-key';
      config.llm.providers.openrouter.api_key = 'sk-or-key';
      // local provider typically has no key
      
      manager.saveApiKeysToSecrets(config);
      
      // Verify secrets file has entries
      const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf-8'));
      const keyCount = Object.keys(secrets).length;
      assert.strictEqual(keyCount, 2, 'two keys saved');
      
      manager.injectApiKeysFromSecrets(config);
      
      assert.strictEqual(config.llm.providers.openai.api_key, 'sk-openai-key');
      assert.strictEqual(config.llm.providers.openrouter.api_key, 'sk-or-key');
    });
  });

  describe('Redaction Flow', () => {
    it('redacts all API keys for renderer safety', () => {
      const paths = { configPath, secretsPath, modelsRoot, localModelsRoot: modelsRoot };
      const config = getDefaultConfig(paths);
      
      config.llm.providers.openai.api_key = 'sk-super-secret-key';
      config.llm.providers.openrouter.api_key = 'aiza-secret-key';
      
      const redacted = redactConfig(config);
      
      // Check that sensitive values are replaced with has_api_key boolean
      const openaiProvider = redacted.llm?.providers?.openai;
      assert.strictEqual(openaiProvider?.has_api_key, true, 'openai has has_api_key flag');
      assert.strictEqual(openaiProvider?.api_key, undefined, 'openai key removed');
      
      const openrouterProvider = redacted.llm?.providers?.openrouter;
      assert.strictEqual(openrouterProvider?.has_api_key, true, 'openrouter has has_api_key flag');
      assert.strictEqual(openrouterProvider?.api_key, undefined, 'openrouter key removed');
    });

    it('preserves config structure during redaction', () => {
      const paths = { configPath, secretsPath, modelsRoot, localModelsRoot: modelsRoot };
      const original = getDefaultConfig(paths);
      
      original.llm.provider = 'gpt-4';
      original.llm.providers.openai.model = 'gpt-4';
      original.tts.engine = 'kitten';
      
      const redacted = redactConfig(original);
      
      // Non-sensitive data preserved
      assert.strictEqual(redacted.llm.provider, 'gpt-4');
      assert.strictEqual(redacted.llm.providers.openai.model, 'gpt-4');
      assert.strictEqual(redacted.tts.engine, 'kitten');
    });
  });

  describe('Deep Merge and Clone Integration', () => {
    it('deep merge preserves default structure when adding new keys', () => {
      const paths = { configPath, secretsPath, modelsRoot, localModelsRoot: modelsRoot };
      const defaults = getDefaultConfig(paths);
      
      const partial = {
        llm: {
          provider: 'new-provider'
        }
      };
      
      const merged = deepMerge(deepClone(defaults), partial);
      
      // New value applied
      assert.strictEqual(merged.llm.provider, 'new-provider');
      
      // Other defaults preserved
      assert.ok(merged.llm.providers, 'llm.providers preserved');
      assert.ok(merged.tts, 'tts section preserved');
      assert.ok(merged.stt, 'stt section preserved');
    });

    it('deep clone creates independent copy', () => {
      const paths = { configPath, secretsPath, modelsRoot, localModelsRoot: modelsRoot };
      const original = getDefaultConfig(paths);
      const clone = deepClone(original);
      
      // Modify clone
      clone.llm.provider = 'modified';
      
      // Original unchanged
      assert.notStrictEqual(original.llm.provider, 'modified');
    });
  });

  describe('Error Handling', () => {
    it('handles malformed JSON config file', () => {
      fs.writeFileSync(configPath, 'not valid json {');
      
      // Should return fallback
      const read = readJsonSafe(configPath, { fallback: true });
      assert.deepStrictEqual(read, { fallback: true });
    });

    it('handles empty config file', () => {
      fs.writeFileSync(configPath, '');
      
      const read = readJsonSafe(configPath, { default: 'value' });
      assert.deepStrictEqual(read, { default: 'value' });
    });

    it('handles secrets file corruption gracefully', () => {
      const crypto = new MemoryCryptoProvider(true);
      const paths = { configPath, secretsPath, modelsRoot, localModelsRoot: modelsRoot };
      
      // Write invalid secrets
      fs.writeFileSync(secretsPath, 'not valid json');
      
      const manager = new SecretsManager(crypto, paths);
      const config = getDefaultConfig(paths);
      
      // Should not throw - injectApiKeysFromSecrets handles missing/corrupt files
      manager.injectApiKeysFromSecrets(config);
      
      // Config should still be valid (just without injected keys)
      assert.ok(config, 'config is valid');
    });
  });
});

describe('Slugify Integration', () => {
  it('slugifies model names for file paths', () => {
    const modelNames = [
      'GPT-4 Turbo',
      'Claude 3 Opus',
      'Llama 2 70B Chat',
      'Qwen/Qwen2.5-72B-Instruct'
    ];
    
    const slugs = modelNames.map(slugify);
    
    assert.strictEqual(slugs[0], 'gpt-4-turbo');
    assert.strictEqual(slugs[1], 'claude-3-opus');
    assert.strictEqual(slugs[2], 'llama-2-70b-chat');
    assert.strictEqual(slugs[3], 'qwen-qwen2-5-72b-instruct');
    
    // All slugs should be valid for file paths
    for (const slug of slugs) {
      assert.ok(/^[a-z0-9-]+$/.test(slug), `${slug} is valid for file path`);
    }
  });
});
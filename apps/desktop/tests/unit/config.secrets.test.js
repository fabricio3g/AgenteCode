/**
 * Tests for secrets management functions.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  PlaintextCryptoProvider,
  MemoryCryptoProvider,
  SecretsManager,
  createPlaintextSecretsManager,
  createMemorySecretsManager,
} from '../../main/config.secrets.ts';

// Helper to create temp directory for file tests
let tempDir;

function createTempDir() {
  tempDir = path.join(os.tmpdir(), `chatealm-secrets-test-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
}

function cleanupTempDir() {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

function getTestPaths() {
  return {
    secretsPath: path.join(tempDir, 'secrets.json'),
  };
}

// ── PlaintextCryptoProvider tests ───────────────────────────────────────────

describe('PlaintextCryptoProvider', () => {
  const provider = new PlaintextCryptoProvider();

  it('returns false for encryption availability', () => {
    assert.strictEqual(provider.isEncryptionAvailable(), false);
  });

  it('returns plaintext unchanged from encrypt', () => {
    const plaintext = 'my-secret-key';
    assert.strictEqual(provider.encrypt(plaintext), plaintext);
  });

  it('returns ciphertext unchanged from decrypt', () => {
    const ciphertext = 'my-secret-key';
    assert.strictEqual(provider.decrypt(ciphertext), ciphertext);
  });

  it('handles empty string', () => {
    assert.strictEqual(provider.encrypt(''), '');
    assert.strictEqual(provider.decrypt(''), '');
  });

  it('handles null-like values', () => {
    assert.strictEqual(provider.encrypt(undefined), undefined);
    assert.strictEqual(provider.decrypt(undefined), undefined);
  });
});

// ── MemoryCryptoProvider tests ──────────────────────────────────────────────

describe('MemoryCryptoProvider', () => {
  const provider = new MemoryCryptoProvider();

  beforeEach(() => {
    provider.clear();
    provider.setEncryptionAvailable(true);
  });

  it('returns true for encryption availability', () => {
    assert.strictEqual(provider.isEncryptionAvailable(), true);
  });

  it('can disable encryption availability', () => {
    provider.setEncryptionAvailable(false);
    assert.strictEqual(provider.isEncryptionAvailable(), false);
  });

  it('encrypts plaintext with ENC prefix', () => {
    const plaintext = 'my-secret-key';
    const encrypted = provider.encrypt(plaintext);
    assert.ok(encrypted.startsWith('ENC:'));
    assert.ok(encrypted !== plaintext);
  });

  it('decrypts encrypted value back to plaintext', () => {
    const plaintext = 'my-secret-key';
    const encrypted = provider.encrypt(plaintext);
    const decrypted = provider.decrypt(encrypted);
    assert.strictEqual(decrypted, plaintext);
  });

  it('returns unchanged value for non-encrypted input', () => {
    const value = 'not-encrypted';
    const decrypted = provider.decrypt(value);
    assert.strictEqual(decrypted, value);
  });

  it('handles empty string', () => {
    const encrypted = provider.encrypt('');
    assert.strictEqual(encrypted, '');
    assert.strictEqual(provider.decrypt(''), '');
  });

  it('clears stored data', () => {
    provider.encrypt('secret1');
    provider.encrypt('secret2');
    provider.clear();
    // After clear, can still decrypt using base64 fallback
    const encrypted = provider.encrypt('secret1');
    assert.ok(encrypted.startsWith('ENC:'));
  });

  it('handles multiple encrypt/decrypt cycles', () => {
    const values = ['key1', 'key2', 'key3'];
    const encryptedValues = values.map(v => provider.encrypt(v));
    
    for (let i = 0; i < values.length; i++) {
      const decrypted = provider.decrypt(encryptedValues[i]);
      assert.strictEqual(decrypted, values[i]);
    }
  });

  it('returns plaintext when encryption unavailable', () => {
    provider.setEncryptionAvailable(false);
    const plaintext = 'my-secret-key';
    assert.strictEqual(provider.encrypt(plaintext), plaintext);
  });
});

// ── SecretsManager core tests ───────────────────────────────────────────────

describe('SecretsManager', () => {
  beforeEach(() => {
    createTempDir();
  });

  afterEach(() => {
    cleanupTempDir();
  });

  describe('with PlaintextCryptoProvider', () => {
    let manager;

    beforeEach(() => {
      manager = createPlaintextSecretsManager(getTestPaths());
    });

    it('canEncrypt returns false', () => {
      assert.strictEqual(manager.canEncrypt(), false);
    });

    it('encryptSecret returns unchanged value', () => {
      assert.strictEqual(manager.encryptSecret('secret'), 'secret');
    });

    it('decryptSecret returns unchanged value', () => {
      assert.strictEqual(manager.decryptSecret('secret'), 'secret');
    });

    it('readSecrets returns empty object for missing file', () => {
      const secrets = manager.readSecrets();
      assert.deepStrictEqual(secrets, {});
    });

    it('writeSecrets creates secrets file', () => {
      manager.writeSecrets({ 'test.key': 'value' });
      const secrets = manager.readSecrets();
      assert.strictEqual(secrets['test.key'], 'value');
    });

    it('getSecret retrieves stored secret', () => {
      manager.setSecret('test.key', 'my-value');
      assert.strictEqual(manager.getSecret('test.key'), 'my-value');
    });

    it('getSecret returns undefined for missing key', () => {
      assert.strictEqual(manager.getSecret('missing.key'), undefined);
    });

    it('deleteSecret removes secret', () => {
      manager.setSecret('test.key', 'value');
      manager.deleteSecret('test.key');
      assert.strictEqual(manager.getSecret('test.key'), undefined);
    });

    it('clearAllSecrets removes all secrets', () => {
      manager.setSecret('key1', 'value1');
      manager.setSecret('key2', 'value2');
      manager.clearAllSecrets();
      assert.deepStrictEqual(manager.readSecrets(), {});
    });
  });

  describe('with MemoryCryptoProvider', () => {
    let manager;

    beforeEach(() => {
      manager = createMemorySecretsManager(getTestPaths());
    });

    it('canEncrypt returns true', () => {
      assert.strictEqual(manager.canEncrypt(), true);
    });

    it('encryptSecret returns encrypted value', () => {
      const encrypted = manager.encryptSecret('secret');
      assert.ok(encrypted.startsWith('ENC:'));
    });

    it('decryptSecret returns decrypted value', () => {
      manager.setSecret('test.key', 'secret');
      const value = manager.getSecret('test.key');
      assert.strictEqual(value, 'secret');
    });

    it('round-trips encrypted secrets', () => {
      const original = 'my-api-key-12345';
      manager.setSecret('llm.providers.openai.api_key', original);
      const retrieved = manager.getSecret('llm.providers.openai.api_key');
      assert.strictEqual(retrieved, original);
    });
  });
});

// ── saveApiKeysToSecrets tests ───────────────────────────────────────────────

describe('saveApiKeysToSecrets', () => {
  beforeEach(() => {
    createTempDir();
  });

  afterEach(() => {
    cleanupTempDir();
  });

  it('extracts and encrypts LLM provider API keys', () => {
    const manager = createMemorySecretsManager(getTestPaths());
    const config = {
      llm: {
        providers: {
          openai: { api_key: 'sk-openai-secret', model: 'gpt-4' },
          anthropic: { api_key: 'sk-ant-secret', model: 'claude' },
        }
      },
      tts: {},
      rag: {},
      stt: {},
      onboarding: {}
    };

    manager.saveApiKeysToSecrets(config);

    // API keys should be cleared in config
    assert.strictEqual(config.llm.providers.openai.api_key, '');
    assert.strictEqual(config.llm.providers.anthropic.api_key, '');

    // Secrets should be stored
    const secrets = manager.readSecrets();
    assert.ok(secrets['llm.providers.openai.api_key']);
    assert.ok(secrets['llm.providers.anthropic.api_key']);

    // Decrypted values should match originals
    assert.strictEqual(manager.getSecret('llm.providers.openai.api_key'), 'sk-openai-secret');
    assert.strictEqual(manager.getSecret('llm.providers.anthropic.api_key'), 'sk-ant-secret');
  });

  it('handles search provider API keys', () => {
    const manager = createMemorySecretsManager(getTestPaths());
    const config = {
      search: {
        providers: {
          google: { api_key: 'google-api-key' },
        }
      },
      llm: { providers: {} },
      tts: {},
      rag: {},
      stt: {},
      onboarding: {}
    };

    manager.saveApiKeysToSecrets(config);

    assert.strictEqual(config.search.providers.google.api_key, '');
    assert.strictEqual(manager.getSecret('search.providers.google.api_key'), 'google-api-key');
  });

  it('skips providers without API keys', () => {
    const manager = createMemorySecretsManager(getTestPaths());
    const config = {
      llm: {
        providers: {
          openai: { api_key: 'sk-test', model: 'gpt-4' },
          lmstudio: { api_key: '', model: '' },
          custom: { model: 'custom-model' },
        }
      },
      tts: {},
      rag: {},
      stt: {},
      onboarding: {}
    };

    manager.saveApiKeysToSecrets(config);

    const secrets = manager.readSecrets();
    assert.ok(secrets['llm.providers.openai.api_key']);
    assert.strictEqual(secrets['llm.providers.lmstudio.api_key'], undefined);
    assert.strictEqual(secrets['llm.providers.custom.api_key'], undefined);
  });

  it('handles config without providers', () => {
    const manager = createMemorySecretsManager(getTestPaths());
    const config = {
      llm: {},
      tts: {},
      rag: {},
      stt: {},
      onboarding: {}
    };

    manager.saveApiKeysToSecrets(config);

    const secrets = manager.readSecrets();
    assert.deepStrictEqual(secrets, {});
  });

  it('preserves existing secrets when adding new ones', () => {
    const manager = createMemorySecretsManager(getTestPaths());
    
    // Pre-store a secret
    manager.setSecret('existing.key', 'existing-value');

    const config = {
      llm: {
        providers: {
          openai: { api_key: 'new-key' },
        }
      },
      tts: {},
      rag: {},
      stt: {},
      onboarding: {}
    };

    manager.saveApiKeysToSecrets(config);

    // Existing secret should still be there
    assert.strictEqual(manager.getSecret('existing.key'), 'existing-value');
    assert.strictEqual(manager.getSecret('llm.providers.openai.api_key'), 'new-key');
  });
});

// ── injectApiKeysFromSecrets tests ───────────────────────────────────────────

describe('injectApiKeysFromSecrets', () => {
  beforeEach(() => {
    createTempDir();
  });

  afterEach(() => {
    cleanupTempDir();
  });

  it('injects API keys into LLM providers', () => {
    const manager = createMemorySecretsManager(getTestPaths());
    
    // Store secrets first
    manager.setSecret('llm.providers.openai.api_key', 'sk-openai-restored');
    manager.setSecret('llm.providers.anthropic.api_key', 'sk-ant-restored');

    const config = {
      llm: {
        providers: {
          openai: { api_key: '', model: 'gpt-4' },
          anthropic: { api_key: '', model: 'claude' },
        }
      },
      tts: {},
      rag: {},
      stt: {},
      onboarding: {}
    };

    manager.injectApiKeysFromSecrets(config);

    assert.strictEqual(config.llm.providers.openai.api_key, 'sk-openai-restored');
    assert.strictEqual(config.llm.providers.anthropic.api_key, 'sk-ant-restored');
  });

  it('injects API keys into search providers', () => {
    const manager = createMemorySecretsManager(getTestPaths());
    manager.setSecret('search.providers.google.api_key', 'google-key-restored');

    const config = {
      search: {
        providers: {
          google: { api_key: '' },
        }
      },
      llm: { providers: {} },
      tts: {},
      rag: {},
      stt: {},
      onboarding: {}
    };

    manager.injectApiKeysFromSecrets(config);

    assert.strictEqual(config.search.providers.google.api_key, 'google-key-restored');
  });

  it('skips providers without stored secrets', () => {
    const manager = createMemorySecretsManager(getTestPaths());
    
    const config = {
      llm: {
        providers: {
          openai: { api_key: '', model: 'gpt-4' },
          newprovider: { api_key: '', model: 'new-model' },
        }
      },
      tts: {},
      rag: {},
      stt: {},
      onboarding: {}
    };

    manager.injectApiKeysFromSecrets(config);

    assert.strictEqual(config.llm.providers.openai.api_key, '');
    assert.strictEqual(config.llm.providers.newprovider.api_key, '');
  });

  it('returns the config object', () => {
    const manager = createMemorySecretsManager(getTestPaths());
    const config = {
      llm: { providers: {} },
      tts: {},
      rag: {},
      stt: {},
      onboarding: {}
    };

    const result = manager.injectApiKeysFromSecrets(config);
    assert.strictEqual(result, config);
  });

  it('handles empty secrets file', () => {
    const manager = createMemorySecretsManager(getTestPaths());
    
    const config = {
      llm: {
        providers: {
          openai: { api_key: 'fallback', model: 'gpt-4' },
        }
      },
      tts: {},
      rag: {},
      stt: {},
      onboarding: {}
    };

    manager.injectApiKeysFromSecrets(config);

    // No secrets to inject, keeps existing value
    assert.strictEqual(config.llm.providers.openai.api_key, 'fallback');
  });
});

// ── Round-trip integration tests ─────────────────────────────────────────────

describe('save/inject round-trip', () => {
  beforeEach(() => {
    createTempDir();
  });

  afterEach(() => {
    cleanupTempDir();
  });

  it('preserves API keys through save/inject cycle', () => {
    const manager = createMemorySecretsManager(getTestPaths());
    
    const originalConfig = {
      llm: {
        providers: {
          openai: { api_key: 'sk-original-key', model: 'gpt-4' },
          anthropic: { api_key: 'sk-ant-original', model: 'claude' },
        }
      },
      search: {
        providers: {
          google: { api_key: 'google-original' },
        }
      },
      tts: {},
      rag: {},
      stt: {},
      onboarding: {}
    };

    // Save API keys (clears them in config)
    manager.saveApiKeysToSecrets(originalConfig);

    // Create a new config to inject into
    const loadedConfig = {
      llm: {
        providers: {
          openai: { api_key: '', model: 'gpt-4' },
          anthropic: { api_key: '', model: 'claude' },
        }
      },
      search: {
        providers: {
          google: { api_key: '' },
        }
      },
      tts: {},
      rag: {},
      stt: {},
      onboarding: {}
    };

    // Inject keys back
    manager.injectApiKeysFromSecrets(loadedConfig);

    // Keys should match originals
    assert.strictEqual(loadedConfig.llm.providers.openai.api_key, 'sk-original-key');
    assert.strictEqual(loadedConfig.llm.providers.anthropic.api_key, 'sk-ant-original');
    assert.strictEqual(loadedConfig.search.providers.google.api_key, 'google-original');
  });

  it('handles plaintext provider correctly', () => {
    const manager = createPlaintextSecretsManager(getTestPaths());
    
    const config = {
      llm: {
        providers: {
          openai: { api_key: 'plaintext-key' },
        }
      },
      tts: {},
      rag: {},
      stt: {},
      onboarding: {}
    };

    // Save - plaintext provider stores as-is
    manager.saveApiKeysToSecrets(config);

    // Check secrets are stored plaintext
    const secrets = manager.readSecrets();
    assert.strictEqual(secrets['llm.providers.openai.api_key'], 'plaintext-key');

    // Inject back
    const loadedConfig = {
      llm: { providers: { openai: { api_key: '' } } },
      tts: {},
      rag: {},
      stt: {},
      onboarding: {}
    };
    manager.injectApiKeysFromSecrets(loadedConfig);

    assert.strictEqual(loadedConfig.llm.providers.openai.api_key, 'plaintext-key');
  });
});
// ── A key the keyring can no longer decrypt ────────────────────────────────

describe('SecretsManager with an undecryptable secret', () => {
  beforeEach(createTempDir);
  afterEach(cleanupTempDir);

  /** Encryption available, but the keyring key for old blobs is gone. */
  class LostKeyCrypto {
    isEncryptionAvailable() { return true; }
    encrypt(plaintext) { return Buffer.from(`v11:new:${plaintext}`).toString('base64'); }
    decrypt(ciphertext) {
      const text = Buffer.from(ciphertext, 'base64').toString();
      return text.startsWith('v11:new:') ? text.slice('v11:new:'.length) : ciphertext;
    }
  }

  it('does not load it, so a later save cannot corrupt it', () => {
    const manager = new SecretsManager(new LostKeyCrypto(), getTestPaths());
    const oldBlob = Buffer.from('v11 encrypted under the old app name').toString('base64');
    manager.writeSecrets({
      'llm.providers.openrouter.api_key': oldBlob,
      'llm.providers.deepseek.api_key': manager.encryptSecret('sk-readable')
    });
    const cfg = { llm: { providers: { openrouter: { api_key: '' }, deepseek: { api_key: '' } } } };

    manager.injectApiKeysFromSecrets(cfg);
    assert.strictEqual(cfg.llm.providers.openrouter.api_key, '', 'the undecryptable key is not loaded');
    assert.strictEqual(cfg.llm.providers.deepseek.api_key, 'sk-readable');
    assert.strictEqual(manager.getSecret('llm.providers.openrouter.api_key'), undefined);

    manager.saveApiKeysToSecrets(cfg);
    const saved = manager.readSecrets();
    assert.strictEqual(saved['llm.providers.openrouter.api_key'], oldBlob, 'left untouched on disk');
    assert.strictEqual(manager.decryptSecret(saved['llm.providers.deepseek.api_key']), 'sk-readable');
  });
});

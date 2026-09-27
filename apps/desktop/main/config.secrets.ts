/**
 * Secret management for API keys and sensitive data.
 * Uses a crypto abstraction that can be replaced with Electron's safeStorage
 * or a test mock.
 */

import { readJsonSafe, writeJsonSafe } from './config.utils.ts';
import type { AppConfig } from './config.types.ts';

/**
 * Crypto provider interface for encryption/decryption.
 * Allows mocking in tests without Electron's safeStorage.
 */
export interface CryptoProvider {
  /** Check if encryption is available */
  isEncryptionAvailable(): boolean;
  /** Encrypt a plaintext string, return base64-encoded ciphertext */
  encrypt(plaintext: string): string;
  /** Decrypt a base64-encoded ciphertext string */
  decrypt(ciphertext: string): string;
}

/**
 * Paths provider interface for getting application paths.
 */
export interface PathsProvider {
  secretsPath: string;
}

/**
 * Default crypto provider that stores plaintext (no encryption).
 * Used for testing or when safeStorage is unavailable.
 */
export class PlaintextCryptoProvider implements CryptoProvider {
  isEncryptionAvailable(): boolean {
    return false;
  }

  encrypt(plaintext: string): string {
    return plaintext;
  }

  decrypt(ciphertext: string): string {
    return ciphertext;
  }
}

/**
 * Memory-backed crypto provider for testing.
 * Simulates encryption by storing values in memory.
 */
export class MemoryCryptoProvider implements CryptoProvider {
  private encryptedData: Map<string, string> = new Map();
  private encryptionAvailable = true;

  isEncryptionAvailable(): boolean {
    return this.encryptionAvailable;
  }

  encrypt(plaintext: string): string {
    if (!plaintext) return plaintext;
    if (!this.encryptionAvailable) return plaintext;
    // Simulate encryption with a prefix
    const ciphertext = `ENC:${Buffer.from(plaintext).toString('base64')}`;
    this.encryptedData.set(ciphertext, plaintext);
    return ciphertext;
  }

  decrypt(ciphertext: string): string {
    if (!ciphertext || !ciphertext.startsWith('ENC:')) return ciphertext;
    const stored = this.encryptedData.get(ciphertext);
    if (stored) return stored;
    // Fallback: decode the base64
    return Buffer.from(ciphertext.slice(4), 'base64').toString();
  }

  /** Set encryption availability for testing */
  setEncryptionAvailable(value: boolean): void {
    this.encryptionAvailable = value;
  }

  /** Clear stored data for testing */
  clear(): void {
    this.encryptedData.clear();
  }
}

/**
 * Secrets manager handles API key storage and retrieval.
 */
export class SecretsManager {
  private crypto: CryptoProvider;
  private paths: PathsProvider;

  constructor(crypto: CryptoProvider, paths: PathsProvider) {
    this.crypto = crypto;
    this.paths = paths;
  }

  /**
   * Checks if encryption is available.
   */
  canEncrypt(): boolean {
    try {
      return this.crypto.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  /**
   * Encrypts a secret value.
   * @param plaintext - The plaintext value to encrypt
   * @returns Encrypted value (base64) or original if encryption unavailable
   */
  encryptSecret(plaintext: string): string {
    if (!plaintext || !this.canEncrypt()) return plaintext;
    try {
      return this.crypto.encrypt(plaintext);
    } catch {
      return plaintext;
    }
  }

  /**
   * Decrypts a secret value.
   * @param ciphertext - Base64-encoded encrypted value
   * @returns Decrypted plaintext or original if decryption fails
   */
  decryptSecret(ciphertext: string): string {
    if (!ciphertext || !this.canEncrypt()) return ciphertext;
    try {
      return this.crypto.decrypt(ciphertext);
    } catch {
      return ciphertext;
    }
  }

  /**
   * Reads secrets from the secrets file.
   * @returns Secrets object or empty object if file doesn't exist
   */
  readSecrets(): Record<string, string> {
    return readJsonSafe(this.paths.secretsPath, {});
  }

  /**
   * Writes secrets to the secrets file.
   * @param secrets - Secrets object to write
   */
  writeSecrets(secrets: Record<string, string>): void {
    writeJsonSafe(this.paths.secretsPath, secrets);
  }

  /**
   * Extracts API keys from config, encrypts them, and saves to secrets file.
   * Clears the api_key fields in the config object.
   * @param cfg - Configuration object (mutated in place)
   */
  saveApiKeysToSecrets(cfg: AppConfig): void {
    const secrets = this.readSecrets();
    
    // Handle LLM providers
    const providers = cfg?.llm?.providers ?? {};
    for (const [name, provider] of Object.entries(providers)) {
      if (provider && typeof provider === 'object' && provider.api_key) {
        secrets[`llm.providers.${name}.api_key`] = this.encryptSecret(provider.api_key);
        provider.api_key = '';
      }
    }

    // Handle search providers
    const searchProviders = cfg?.search?.providers ?? {};
    for (const [name, provider] of Object.entries(searchProviders)) {
      if (provider && typeof provider === 'object' && provider.api_key) {
        secrets[`search.providers.${name}.api_key`] = this.encryptSecret(provider.api_key);
        provider.api_key = '';
      }
    }

    this.writeSecrets(secrets);
  }

  /**
   * Injects decrypted API keys from secrets file into config.
   * @param cfg - Configuration object (mutated in place)
   * @returns The config object with injected keys
   */
  injectApiKeysFromSecrets(cfg: AppConfig): AppConfig {
    const secrets = this.readSecrets();
    
    // Handle LLM providers
    const providers = cfg?.llm?.providers ?? {};
    for (const name of Object.keys(providers)) {
      const secretKey = `llm.providers.${name}.api_key`;
      if (secrets[secretKey] && providers[name]) {
        providers[name].api_key = this.decryptSecret(secrets[secretKey]);
      }
    }

    // Handle search providers
    const searchProviders = cfg?.search?.providers ?? {};
    for (const name of Object.keys(searchProviders)) {
      const secretKey = `search.providers.${name}.api_key`;
      if (secrets[secretKey] && searchProviders[name] && typeof searchProviders[name] === 'object') {
        searchProviders[name].api_key = this.decryptSecret(secrets[secretKey]);
      }
    }

    return cfg;
  }

  /**
   * Gets a single secret value by key.
   * @param key - Secret key path (e.g., 'llm.providers.openai.api_key')
   * @returns Decrypted secret value or undefined
   */
  getSecret(key: string): string | undefined {
    const secrets = this.readSecrets();
    const ciphertext = secrets[key];
    if (!ciphertext) return undefined;
    return this.decryptSecret(ciphertext);
  }

  /**
   * Sets a single secret value.
   * @param key - Secret key path
   * @param value - Plaintext value to encrypt and store
   */
  setSecret(key: string, value: string): void {
    const secrets = this.readSecrets();
    secrets[key] = this.encryptSecret(value);
    this.writeSecrets(secrets);
  }

  /**
   * Deletes a single secret.
   * @param key - Secret key path to delete
   */
  deleteSecret(key: string): void {
    const secrets = this.readSecrets();
    delete secrets[key];
    this.writeSecrets(secrets);
  }

  /**
   * Clears all secrets from the secrets file.
   */
  clearAllSecrets(): void {
    this.writeSecrets({});
  }
}

/**
 * Creates a secrets manager with default plaintext crypto (for testing).
 */
export function createPlaintextSecretsManager(paths: PathsProvider): SecretsManager {
  return new SecretsManager(new PlaintextCryptoProvider(), paths);
}

/**
 * Creates a secrets manager with memory-backed crypto (for testing).
 */
export function createMemorySecretsManager(paths: PathsProvider): SecretsManager {
  return new SecretsManager(new MemoryCryptoProvider(), paths);
}
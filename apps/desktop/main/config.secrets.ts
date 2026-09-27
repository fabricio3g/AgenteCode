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
   * A secret stored encrypted (Chromium's `v10`/`v11` blob) that did not
   * decrypt: the OS keyring no longer holds its key under this app's name.
   * Such a value must never be loaded as a key, or the next save would store
   * the still-encrypted text, encrypted again, and the real key would be lost.
   */
  private isUndecryptable(stored: string, decrypted: string): boolean {
    if (decrypted !== stored || !this.canEncrypt()) return false;
    try {
      return /^v1\d/.test(Buffer.from(stored, 'base64').subarray(0, 3).toString('latin1'));
    } catch {
      return false;
    }
  }

  /** Decrypt a stored secret, or undefined when it cannot be read (see isUndecryptable). */
  private readableSecret(stored: string, key: string): string | undefined {
    const decrypted = this.decryptSecret(stored);
    if (!this.isUndecryptable(stored, decrypted)) return decrypted;
    console.warn(`[secrets] ${key} could not be decrypted; left untouched on disk`);
    return undefined;
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
    this.extractSection(secrets, 'llm.providers', cfg?.llm?.providers);
    this.extractSection(secrets, 'search.providers', cfg?.search?.providers);
    this.writeSecrets(secrets);
  }

  /** Move each provider's key from its config entry into `secrets`, encrypted. */
  private extractSection(secrets: Record<string, string>, prefix: string, providers: Record<string, unknown> | undefined): void {
    for (const [name, provider] of Object.entries(providers ?? {})) {
      const entry = provider as { api_key?: string } | null;
      if (!entry || typeof entry !== 'object' || !entry.api_key) continue;
      secrets[`${prefix}.${name}.api_key`] = this.encryptSecret(entry.api_key);
      entry.api_key = '';
    }
  }

  /**
   * Injects decrypted API keys from secrets file into config.
   * @param cfg - Configuration object (mutated in place)
   * @returns The config object with injected keys
   */
  injectApiKeysFromSecrets(cfg: AppConfig): AppConfig {
    const secrets = this.readSecrets();
    this.injectSection(secrets, 'llm.providers', cfg?.llm?.providers);
    this.injectSection(secrets, 'search.providers', cfg?.search?.providers);
    return cfg;
  }

  /** Put each provider's readable stored key into its config entry. */
  private injectSection(secrets: Record<string, string>, prefix: string, providers: Record<string, unknown> | undefined): void {
    for (const [name, provider] of Object.entries(providers ?? {})) {
      const secretKey = `${prefix}.${name}.api_key`;
      if (!secrets[secretKey] || !provider || typeof provider !== 'object') continue;
      const value = this.readableSecret(secrets[secretKey], secretKey);
      if (value !== undefined) (provider as { api_key?: string }).api_key = value;
    }
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
    return this.readableSecret(ciphertext, key);
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
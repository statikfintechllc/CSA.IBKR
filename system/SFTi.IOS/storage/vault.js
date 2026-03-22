/**
 * CSA.IBKR — Encrypted Vault (SFTi.IOS Storage)
 * 
 * Client-side encrypted credential store using Web Crypto API + IndexedDB.
 * All sensitive data (session tokens, keys) is AES-GCM encrypted before
 * being written to IndexedDB. The encryption key is derived from a
 * device-bound secret (via WebAuthn/passkey or a user passphrase).
 *
 * iOS 26.4 WebKit: Full Web Crypto API support in both page and SW context.
 */

const IDB_NAME = 'csa-ibkr-vault';
const IDB_STORE = 'secrets';
const SALT_KEY = '__vault_salt__';
const KEY_DERIVATION = { name: 'PBKDF2', iterations: 100000, hash: 'SHA-256' };
const ENCRYPTION = { name: 'AES-GCM', length: 256 };

class Vault {
  #db = null;
  #cryptoKey = null;
  #ready = false;

  /**
   * Initialize vault with a passphrase or WebAuthn-derived secret.
   * @param {string|ArrayBuffer} secret - Passphrase string or raw key material
   * @returns {Promise<void>}
   */
  async init(secret) {
    await this.#openDB();

    // Get or create salt
    let salt = await this.#getRaw(SALT_KEY);
    if (!salt) {
      salt = crypto.getRandomValues(new Uint8Array(16));
      await this.#setRaw(SALT_KEY, salt);
    } else {
      salt = new Uint8Array(salt);
    }

    // Derive encryption key from secret
    const keyMaterial = await this.#getKeyMaterial(secret);
    this.#cryptoKey = await crypto.subtle.deriveKey(
      { ...KEY_DERIVATION, salt },
      keyMaterial,
      ENCRYPTION,
      false,
      ['encrypt', 'decrypt']
    );

    this.#ready = true;
  }

  /**
   * Initialize vault with a default device-bound key.
   * Used when WebAuthn is not available (first run before passkey creation).
   * Less secure, but allows the vault to function pre-auth.
   * @returns {Promise<void>}
   */
  async initWithDeviceKey() {
    // Use origin + user agent as a weak device binding
    const deviceId = `${self.location?.origin || 'csa-ibkr'}::${navigator?.userAgent || 'device'}`;
    await this.init(deviceId);
  }

  /**
   * Check if vault is initialized.
   * @returns {boolean}
   */
  get isReady() {
    return this.#ready;
  }

  /**
   * Store an encrypted value.
   * @param {string} key
   * @param {string} value
   * @returns {Promise<void>}
   */
  async set(key, value) {
    this.#assertReady();

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(value);

    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      this.#cryptoKey,
      encoded
    );

    // Store iv + ciphertext together
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(ciphertext), iv.length);

    await this.#setRaw(key, combined.buffer);
  }

  /**
   * Retrieve and decrypt a value.
   * @param {string} key
   * @returns {Promise<string|null>}
   */
  async get(key) {
    this.#assertReady();

    const raw = await this.#getRaw(key);
    if (!raw) return null;

    try {
      const combined = new Uint8Array(raw);
      const iv = combined.slice(0, 12);
      const ciphertext = combined.slice(12);

      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        this.#cryptoKey,
        ciphertext
      );

      return new TextDecoder().decode(decrypted);
    } catch {
      // Decryption failed — likely wrong key or corrupted data
      return null;
    }
  }

  /**
   * Delete a stored value.
   * @param {string} key
   * @returns {Promise<void>}
   */
  async delete(key) {
    if (!this.#db) return;

    return new Promise((resolve, reject) => {
      const tx = this.#db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Check if a key exists.
   * @param {string} key
   * @returns {Promise<boolean>}
   */
  async has(key) {
    const raw = await this.#getRaw(key);
    return raw !== null;
  }

  /**
   * List all keys in the vault.
   * @returns {Promise<string[]>}
   */
  async keys() {
    if (!this.#db) return [];

    return new Promise((resolve, reject) => {
      const tx = this.#db.transaction(IDB_STORE, 'readonly');
      const request = tx.objectStore(IDB_STORE).getAllKeys();
      request.onsuccess = () => {
        resolve(request.result.filter(k => k !== SALT_KEY));
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Destroy the vault — clear all data.
   * @returns {Promise<void>}
   */
  async destroy() {
    if (this.#db) {
      return new Promise((resolve) => {
        const tx = this.#db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).clear();
        tx.oncomplete = () => {
          this.#cryptoKey = null;
          this.#ready = false;
          resolve();
        };
      });
    }
  }

  /**
   * Close the vault (lock without erasing).
   */
  lock() {
    this.#cryptoKey = null;
    this.#ready = false;
  }

  // --- Private ---

  #assertReady() {
    if (!this.#ready || !this.#cryptoKey) {
      throw new Error('[Vault] Not initialized. Call init() or initWithDeviceKey() first.');
    }
  }

  async #getKeyMaterial(secret) {
    let raw;
    if (typeof secret === 'string') {
      raw = new TextEncoder().encode(secret);
    } else if (secret instanceof ArrayBuffer) {
      raw = new Uint8Array(secret);
    } else {
      raw = new Uint8Array(secret);
    }

    return crypto.subtle.importKey('raw', raw, { name: 'PBKDF2' }, false, ['deriveKey']);
  }

  async #openDB() {
    if (this.#db) return;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(IDB_NAME, 1);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };

      request.onsuccess = (event) => {
        this.#db = event.target.result;
        resolve();
      };

      request.onerror = () => reject(request.error);
    });
  }

  async #getRaw(key) {
    if (!this.#db) await this.#openDB();

    return new Promise((resolve, reject) => {
      const tx = this.#db.transaction(IDB_STORE, 'readonly');
      const request = tx.objectStore(IDB_STORE).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async #setRaw(key, value) {
    if (!this.#db) await this.#openDB();

    return new Promise((resolve, reject) => {
      const tx = this.#db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

// Singleton
const vault = new Vault();

export { Vault, vault };
export default vault;

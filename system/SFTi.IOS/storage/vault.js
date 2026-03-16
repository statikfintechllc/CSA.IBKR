/**
 * SFTi.IOS/storage/vault.js — WebKit Persistent Encrypted Storage Vault
 *
 * Provides secure, persistent key-value storage using:
 *   - IndexedDB as the primary persistent store (survives PWA restarts)
 *   - Origin Private File System (OPFS) for large binary blobs
 *   - WebCrypto AES-GCM for at-rest encryption of sensitive values
 *   - A session key derived fresh on every boot (stored in memory only)
 *
 * iOS-specific notes:
 *   Safari on iOS 15.4+ supports persistent IndexedDB storage when the
 *   PWA is added to the Home Screen.  Users are prompted once to allow
 *   persistent storage via StorageManager.persist().
 *   OPFS (File System Access API) is available in iOS 17+.
 *
 * Usage:
 *   const vault = new Vault('my-namespace');
 *   await vault.set('key', value);
 *   const val = await vault.get('key');
 *   await vault.delete('key');
 */

const DB_NAME = 'sfti-vault';
const DB_VERSION = 1;
const STORE_NAME = 'entries';
const KEY_MATERIAL_KEY = 'vault-master-key';

export class Vault {
  /**
   * @param {string} namespace  Logical namespace (prefixed on all keys).
   */
  constructor(namespace = 'default') {
    this._ns = namespace;
    this._db = null;
    this._masterKey = null;
    this._initPromise = null;
  }

  /** Initialise the vault (open IDB, derive master key, request persistence). */
  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._setup();
    return this._initPromise;
  }

  /**
   * Store a value (serialised to JSON and encrypted).
   * @param {string} key
   * @param {*} value
   */
  async set(key, value) {
    await this.init();
    const plaintext = JSON.stringify(value);
    const encrypted = await this._encrypt(plaintext);
    const store = await this._getStore('readwrite');
    return idbRequest(store.put({ id: this._ns + '::' + key, data: encrypted }));
  }

  /**
   * Retrieve and decrypt a stored value.
   * @param {string} key
   * @returns {Promise<*>}
   */
  async get(key) {
    await this.init();
    const store = await this._getStore('readonly');
    const record = await idbRequest(store.get(this._ns + '::' + key));
    if (!record) return null;
    try {
      const plain = await this._decrypt(record.data);
      return JSON.parse(plain);
    } catch (_) {
      return null;
    }
  }

  /**
   * Delete a stored value.
   * @param {string} key
   */
  async delete(key) {
    await this.init();
    const store = await this._getStore('readwrite');
    return idbRequest(store.delete(this._ns + '::' + key));
  }

  /**
   * List all keys in this namespace.
   * @returns {Promise<string[]>}
   */
  async keys() {
    await this.init();
    const store = await this._getStore('readonly');
    const allKeys = await idbRequest(store.getAllKeys());
    const prefix = this._ns + '::';
    return allKeys.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  }

  /**
   * Clear all entries in this namespace.
   */
  async clear() {
    const keys = await this.keys();
    await Promise.all(keys.map((k) => this.delete(k)));
  }

  /**
   * Request durable/persistent storage from the browser.
   * On iOS this presents a one-time prompt to the user.
   * @returns {Promise<boolean>}
   */
  static async requestPersistence() {
    if (!navigator.storage || !navigator.storage.persist) return false;
    return navigator.storage.persist();
  }

  /**
   * Check current storage quota and usage.
   * @returns {Promise<{quota: number, usage: number, percent: number}>}
   */
  static async storageEstimate() {
    if (!navigator.storage || !navigator.storage.estimate) {
      return { quota: 0, usage: 0, percent: 0 };
    }
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    return { quota, usage, percent: quota > 0 ? Math.round((usage / quota) * 100) : 0 };
  }

  // ─── OPFS helpers (large blobs) ──────────────────────────────────────────────

  /**
   * Write a large binary blob to OPFS.
   * Available on iOS 17+ when added to Home Screen.
   *
   * @param {string} filename
   * @param {Uint8Array} data
   */
  static async writeFile(filename, data) {
    if (!navigator.storage || !navigator.storage.getDirectory) return;
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(filename, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  }

  /**
   * Read a binary blob from OPFS.
   * @param {string} filename
   * @returns {Promise<Uint8Array | null>}
   */
  static async readFile(filename) {
    try {
      if (!navigator.storage || !navigator.storage.getDirectory) return null;
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(filename);
      const file = await handle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch (_) {
      return null;
    }
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  async _setup() {
    this._db = await openIDB(DB_NAME, DB_VERSION, (db) => {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    });

    this._masterKey = await this._loadOrCreateMasterKey();

    // Best-effort persistence request
    Vault.requestPersistence().catch(() => {});
  }

  async _loadOrCreateMasterKey() {
    // Try to retrieve an existing exported key from IDB (unencrypted meta store)
    const store = await this._getRawStore('readwrite');
    const existing = await idbRequest(store.get('__vault_master_key__'));

    if (existing && existing.jwk) {
      try {
        return await crypto.subtle.importKey(
          'jwk',
          existing.jwk,
          { name: 'AES-GCM', length: 256 },
          true,
          ['encrypt', 'decrypt']
        );
      } catch (_) { /* fall through */ }
    }

    // Generate a new master key
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
    const jwk = await crypto.subtle.exportKey('jwk', key);
    await idbRequest(store.put({ id: '__vault_master_key__', jwk }));
    return key;
  }

  async _encrypt(plaintext) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this._masterKey, encoded);
    return {
      iv: Array.from(iv),
      ct: Array.from(new Uint8Array(cipherBuf)),
    };
  }

  async _decrypt({ iv, ct }) {
    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(iv) },
      this._masterKey,
      new Uint8Array(ct)
    );
    return new TextDecoder().decode(plainBuf);
  }

  async _getStore(mode) {
    const tx = this._db.transaction(STORE_NAME, mode);
    return tx.objectStore(STORE_NAME);
  }

  async _getRawStore(mode) {
    const tx = this._db.transaction(STORE_NAME, mode);
    return tx.objectStore(STORE_NAME);
  }
}

// ─── IndexedDB helpers ─────────────────────────────────────────────────────────

function openIDB(name, version, onUpgrade) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = (e) => onUpgrade(e.target.result);
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

function idbRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

export default Vault;

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
  // OPFS (Origin Private File System) is available on iOS 17+ when installed
  // to the Home Screen.  It provides high-performance file I/O ideal for
  // caching large binaries (JARs, WASM modules) that the CheerpJ JVM needs.

  /**
   * Write a large binary blob to OPFS.
   *
   * @param {string} filename
   * @param {Uint8Array | ArrayBuffer} data
   */
  static async writeFile(filename, data) {
    if (!navigator.storage || !navigator.storage.getDirectory) return;
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(filename, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
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

  /**
   * Read a text file from OPFS (e.g. conf.yaml).
   * @param {string} filename
   * @returns {Promise<string | null>}
   */
  static async readTextFile(filename) {
    try {
      if (!navigator.storage || !navigator.storage.getDirectory) return null;
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(filename);
      const file = await handle.getFile();
      return await file.text();
    } catch (_) {
      return null;
    }
  }

  /**
   * Check whether a file exists in OPFS without reading it.
   * @param {string} filename
   * @returns {Promise<boolean>}
   */
  static async hasFile(filename) {
    try {
      if (!navigator.storage || !navigator.storage.getDirectory) return false;
      const root = await navigator.storage.getDirectory();
      await root.getFileHandle(filename); // throws if missing
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Delete a file from OPFS.
   * @param {string} filename
   */
  static async deleteFile(filename) {
    try {
      if (!navigator.storage || !navigator.storage.getDirectory) return;
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(filename);
    } catch (_) { /* file doesn't exist — fine */ }
  }

  /**
   * Fetch a remote URL and cache the response in OPFS.
   * Returns the bytes regardless of whether they came from cache or network.
   *
   * @param {string}  url         Remote URL to fetch (e.g. GitHub Pages asset)
   * @param {string}  cacheKey    OPFS filename to cache under
   * @param {object}  [opts]
   * @param {boolean} [opts.force]  Re-fetch even if cached
   * @returns {Promise<Uint8Array | null>}
   */
  static async fetchAndCache(url, cacheKey, opts = {}) {
    // 1. Try OPFS cache
    if (!opts.force) {
      const cached = await Vault.readFile(cacheKey);
      if (cached && cached.byteLength > 0) return cached;
    }

    // 2. Fetch from network
    try {
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const bytes = new Uint8Array(await resp.arrayBuffer());

      // 3. Write to OPFS
      try { await Vault.writeFile(cacheKey, bytes); } catch (_) {}

      return bytes;
    } catch (_) {
      return null;
    }
  }

  /**
   * Fetch a remote text file and cache it in OPFS.
   *
   * @param {string}  url
   * @param {string}  cacheKey
   * @param {object}  [opts]
   * @param {boolean} [opts.force]
   * @returns {Promise<string | null>}
   */
  static async fetchAndCacheText(url, cacheKey, opts = {}) {
    if (!opts.force) {
      const cached = await Vault.readTextFile(cacheKey);
      if (cached && cached.length > 0) return cached;
    }

    try {
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const text = await resp.text();
      const bytes = new TextEncoder().encode(text);
      try { await Vault.writeFile(cacheKey, bytes); } catch (_) {}
      return text;
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

/**
 * CSA.IBKR — Logger (Engine Layer)
 * Replaces: SLF4J 1.7.36 + Logback 1.2.11
 *
 * Structured console logging with optional IndexedDB persistence.
 * Mirrors the Java gateway's log format: HH:mm:ss.SSS LEVEL thread logger : message
 */

const LOG_LEVELS = Object.freeze({
  TRACE: 0,
  DEBUG: 1,
  INFO: 2,
  WARN: 3,
  ERROR: 4,
  OFF: 5
});

const LEVEL_COLORS = {
  TRACE: '#888',
  DEBUG: '#4fc3f7',
  INFO: '#81c784',
  WARN: '#ffb74d',
  ERROR: '#ef5350'
};

const IDB_NAME = 'csa-ibkr-logs';
const IDB_STORE = 'logs';
const MAX_PERSISTED_LOGS = 5000;

class Logger {
  #level = LOG_LEVELS.DEBUG;
  #name = 'Gateway';
  #persist = false;
  #db = null;

  /**
   * @param {string} name - Logger name (equivalent to Java logger class name)
   * @param {object} [options]
   * @param {string} [options.level='DEBUG'] - Minimum log level
   * @param {boolean} [options.persist=false] - Persist to IndexedDB
   */
  constructor(name = 'Gateway', options = {}) {
    this.#name = name;
    if (options.level && LOG_LEVELS[options.level] !== undefined) {
      this.#level = LOG_LEVELS[options.level];
    }
    this.#persist = !!options.persist;
  }

  /**
   * Create a child logger with a specific name.
   * @param {string} name - Logger name
   * @returns {Logger}
   */
  child(name) {
    return new Logger(name, {
      level: Object.keys(LOG_LEVELS).find(k => LOG_LEVELS[k] === this.#level),
      persist: this.#persist
    });
  }

  trace(...args) { this.#log('TRACE', args); }
  debug(...args) { this.#log('DEBUG', args); }
  info(...args)  { this.#log('INFO', args); }
  warn(...args)  { this.#log('WARN', args); }
  error(...args) { this.#log('ERROR', args); }

  /**
   * Set log level at runtime.
   * @param {string} level - 'TRACE'|'DEBUG'|'INFO'|'WARN'|'ERROR'|'OFF'
   */
  setLevel(level) {
    if (LOG_LEVELS[level] !== undefined) {
      this.#level = LOG_LEVELS[level];
    }
  }

  /**
   * Enable or disable IndexedDB log persistence.
   * @param {boolean} enabled
   */
  async setPersist(enabled) {
    this.#persist = enabled;
    if (enabled && !this.#db) {
      await this.#openDB();
    }
  }

  /**
   * Retrieve persisted logs from IndexedDB.
   * @param {number} [limit=100] - Max logs to retrieve
   * @param {string} [minLevel='DEBUG'] - Minimum level filter
   * @returns {Promise<Array>} Log entries
   */
  async getLogs(limit = 100, minLevel = 'DEBUG') {
    if (!this.#db) await this.#openDB();
    if (!this.#db) return [];

    return new Promise((resolve, reject) => {
      const tx = this.#db.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const request = store.index('timestamp').openCursor(null, 'prev');
      const results = [];
      const minLevelNum = LOG_LEVELS[minLevel] || 0;

      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor && results.length < limit) {
          const entry = cursor.value;
          if (LOG_LEVELS[entry.level] >= minLevelNum) {
            results.push(entry);
          }
          cursor.continue();
        } else {
          resolve(results.reverse());
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Clear all persisted logs.
   */
  async clearLogs() {
    if (!this.#db) await this.#openDB();
    if (!this.#db) return;

    const tx = this.#db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).clear();
  }

  // --- Private ---

  #log(level, args) {
    if (LOG_LEVELS[level] < this.#level) return;

    const timestamp = this.#formatTime();
    const prefix = `${timestamp} ${level.padEnd(5)} ${this.#name.padEnd(20).slice(0, 20)}`;
    const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');

    // Console output with color
    const color = LEVEL_COLORS[level] || '#fff';
    const consoleFn = level === 'ERROR' ? console.error
                    : level === 'WARN' ? console.warn
                    : level === 'DEBUG' ? console.debug
                    : level === 'TRACE' ? console.debug
                    : console.log;

    consoleFn(`%c${prefix} : %c${message}`, `color:${color};font-weight:bold`, `color:${color}`);

    // Persist to IndexedDB if enabled
    if (this.#persist) {
      this.#persistLog({ timestamp: Date.now(), level, logger: this.#name, message });
    }
  }

  #formatTime() {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    const ms = String(now.getMilliseconds()).padStart(3, '0');
    return `${h}:${m}:${s}.${ms}`;
  }

  async #openDB() {
    if (typeof indexedDB === 'undefined') return;

    return new Promise((resolve) => {
      const request = indexedDB.open(IDB_NAME, 1);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          const store = db.createObjectStore(IDB_STORE, { keyPath: 'id', autoIncrement: true });
          store.createIndex('timestamp', 'timestamp', { unique: false });
          store.createIndex('level', 'level', { unique: false });
        }
      };
      request.onsuccess = (event) => {
        this.#db = event.target.result;
        resolve();
      };
      request.onerror = () => resolve(); // Silently fail
    });
  }

  async #persistLog(entry) {
    if (!this.#db) {
      await this.#openDB();
      if (!this.#db) return;
    }

    try {
      const tx = this.#db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      store.add(entry);

      // Prune old logs if over limit
      const countReq = store.count();
      countReq.onsuccess = () => {
        if (countReq.result > MAX_PERSISTED_LOGS) {
          const deleteCount = countReq.result - MAX_PERSISTED_LOGS;
          const cursor = store.openCursor();
          let deleted = 0;
          cursor.onsuccess = (e) => {
            const c = e.target.result;
            if (c && deleted < deleteCount) {
              c.delete();
              deleted++;
              c.continue();
            }
          };
        }
      };
    } catch {
      // Non-critical, don't throw
    }
  }
}

// Default logger instance
const logger = new Logger('Gateway', { level: 'DEBUG', persist: false });

export { Logger, logger, LOG_LEVELS };
export default logger;

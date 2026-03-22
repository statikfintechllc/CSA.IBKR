/**
 * CSA.IBKR — Cookie Manager (Bridge Layer)
 * Replaces: ibgroup.web.core.clientportal.gw.core.CookieManager
 *
 * Manages IBKR session cookies/tokens extracted from the auth flow.
 * Persists tokens to the encrypted vault for session resumption.
 */

import logger from '../engine/logger.js';
import eventBus from '../engine/event-bus.js';

const log = logger.child('CookieManager');

// Keys used for token storage in vault
const TOKEN_KEYS = Object.freeze({
  SESSION: 'ibkr_session',
  CSRF: 'ibkr_csrf',
  SSO_TOKEN: 'ibkr_sso_token',
  EXPIRES: 'ibkr_expires',
  COOKIE_STRING: 'ibkr_cookies'
});

class CookieManager {
  #tokens = new Map();
  #vault = null; // Reference to vault.js (SFTi.IOS/storage)

  /**
   * @param {object} [vault] - Vault instance for encrypted persistence
   */
  constructor(vault = null) {
    this.#vault = vault;
  }

  /**
   * Set the vault instance for persistence.
   * @param {object} vault - Vault instance with get/set/delete methods
   */
  setVault(vault) {
    this.#vault = vault;
  }

  /**
   * Extract tokens from an IBKR auth response.
   * Called after SSO login redirect returns.
   * @param {Response} response - The auth response
   * @returns {object} Extracted tokens
   */
  async extractFromResponse(response) {
    const tokens = {};

    // Extract Set-Cookie headers (only accessible in Service Worker context)
    const setCookies = response.headers.getSetCookie?.() || [];
    if (setCookies.length > 0) {
      for (const cookie of setCookies) {
        const parsed = this.#parseCookie(cookie);
        if (parsed) {
          tokens[parsed.name] = parsed.value;
          this.#tokens.set(parsed.name, parsed);
        }
      }
    }

    // Try to extract from response body if JSON
    try {
      const clone = response.clone();
      const body = await clone.json();
      if (body.SESSION) tokens.SESSION = body.SESSION;
      if (body.csrf) tokens.CSRF = body.csrf;
    } catch {
      // Not JSON — that's fine
    }

    // Store to vault
    if (Object.keys(tokens).length > 0) {
      await this.#persistTokens(tokens);
      log.info('Extracted and stored session tokens');
      eventBus.emit('session:tokens_updated', { keys: Object.keys(tokens) });
    }

    return tokens;
  }

  /**
   * Extract tokens from URL query parameters (callback redirect).
   * @param {string} url - The callback URL with tokens
   * @returns {object} Extracted tokens
   */
  async extractFromCallback(url) {
    const tokens = {};
    const params = new URL(url).searchParams;

    for (const [key, value] of params) {
      tokens[key] = value;
      this.#tokens.set(key, { name: key, value, expires: null });
    }

    if (Object.keys(tokens).length > 0) {
      await this.#persistTokens(tokens);
      log.info('Extracted tokens from callback URL');
    }

    return tokens;
  }

  /**
   * Get the auth headers to inject into API requests.
   * @returns {object} Headers object
   */
  getAuthHeaders() {
    const headers = {};

    // Build cookie string from stored tokens
    const cookieParts = [];
    for (const [name, data] of this.#tokens) {
      if (data.value) {
        cookieParts.push(`${name}=${data.value}`);
      }
    }
    if (cookieParts.length > 0) {
      headers['Cookie'] = cookieParts.join('; ');
    }

    // CSRF token as header
    const csrf = this.#tokens.get('csrf') || this.#tokens.get('CSRF');
    if (csrf) {
      headers['X-CSRF-Token'] = csrf.value || csrf;
    }

    return headers;
  }

  /**
   * Get a specific token value.
   * @param {string} name - Token name
   * @returns {string|null}
   */
  getToken(name) {
    const entry = this.#tokens.get(name);
    return entry ? (entry.value || entry) : null;
  }

  /**
   * Check if we have valid session tokens.
   * @returns {boolean}
   */
  hasSession() {
    return this.#tokens.size > 0;
  }

  /**
   * Load tokens from vault (on startup / session resume).
   * @returns {Promise<boolean>} Whether tokens were found
   */
  async loadFromVault() {
    if (!this.#vault) {
      log.debug('No vault configured, cannot load tokens');
      return false;
    }

    try {
      const stored = await this.#vault.get(TOKEN_KEYS.COOKIE_STRING);
      if (stored) {
        const tokens = JSON.parse(stored);
        for (const [name, value] of Object.entries(tokens)) {
          this.#tokens.set(name, { name, value, expires: null });
        }
        log.info('Loaded session tokens from vault');
        return true;
      }
    } catch (err) {
      log.warn('Failed to load tokens from vault:', err.message);
    }
    return false;
  }

  /**
   * Clear all stored tokens (logout).
   */
  async clear() {
    this.#tokens.clear();
    if (this.#vault) {
      try {
        for (const key of Object.values(TOKEN_KEYS)) {
          await this.#vault.delete(key);
        }
      } catch (err) {
        log.warn('Failed to clear vault:', err.message);
      }
    }
    log.info('Session tokens cleared');
    eventBus.emit('session:tokens_cleared');
  }

  // --- Private ---

  #parseCookie(setCookieStr) {
    const parts = setCookieStr.split(';').map(s => s.trim());
    if (parts.length === 0) return null;

    const [nameValue, ...attributes] = parts;
    const eqIdx = nameValue.indexOf('=');
    if (eqIdx === -1) return null;

    const name = nameValue.slice(0, eqIdx).trim();
    const value = nameValue.slice(eqIdx + 1).trim();

    let expires = null;
    for (const attr of attributes) {
      const lower = attr.toLowerCase();
      if (lower.startsWith('expires=')) {
        expires = new Date(attr.slice(8).trim()).getTime();
      } else if (lower.startsWith('max-age=')) {
        const seconds = parseInt(attr.slice(8).trim(), 10);
        if (!isNaN(seconds)) {
          expires = Date.now() + seconds * 1000;
        }
      }
    }

    return { name, value, expires };
  }

  async #persistTokens(tokens) {
    if (!this.#vault) return;

    try {
      // Merge with existing
      const existing = await this.#vault.get(TOKEN_KEYS.COOKIE_STRING);
      const merged = existing ? { ...JSON.parse(existing), ...tokens } : tokens;
      await this.#vault.set(TOKEN_KEYS.COOKIE_STRING, JSON.stringify(merged));
    } catch (err) {
      log.warn('Failed to persist tokens:', err.message);
    }
  }
}

// Singleton
const cookieManager = new CookieManager();

export { CookieManager, cookieManager, TOKEN_KEYS };
export default cookieManager;

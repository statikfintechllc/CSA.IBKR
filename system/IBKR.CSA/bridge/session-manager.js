/**
 * CSA.IBKR — Session Manager (Bridge Layer)
 * Replaces: Vert.x HTTP session handling + auth state management
 *
 * Manages the full session lifecycle:
 *   init → authenticate → validate → keepalive → refresh → destroy
 */

import logger from '../engine/logger.js';
import eventBus from '../engine/event-bus.js';
import configLoader from '../engine/config-loader.js';
import { classifyError, handleError, withRetry } from '../engine/error-handler.js';
import cookieManager from './cookie-manager.js';
import authFlow from './auth-flow.js';

const log = logger.child('SessionManager');

// Session states
const SessionState = Object.freeze({
  DISCONNECTED: 'DISCONNECTED',
  AUTHENTICATING: 'AUTHENTICATING',
  CONNECTED: 'CONNECTED',
  COMPETING: 'COMPETING',
  ERROR: 'ERROR'
});

class SessionManager {
  #state = SessionState.DISCONNECTED;
  #keepaliveTimer = null;
  #accountId = null;
  #accounts = [];

  /**
   * Get current session state.
   */
  get state() { return this.#state; }
  get isConnected() { return this.#state === SessionState.CONNECTED; }
  get accountId() { return this.#accountId; }
  get accounts() { return [...this.#accounts]; }

  /**
   * Initialize session — attempt to resume from vault, else authenticate.
   * @returns {Promise<boolean>} Whether session is active
   */
  async init() {
    log.info('Initializing session...');
    this.#state = SessionState.AUTHENTICATING;

    // Try to resume existing session from vault
    const hasTokens = await cookieManager.loadFromVault();
    if (hasTokens) {
      log.debug('Found stored tokens, validating session...');
      const valid = await this.validate();
      if (valid) {
        log.info('Resumed existing session');
        return true;
      }
      log.warn('Stored session is invalid, clearing...');
      await cookieManager.clear();
    }

    // No valid session — need fresh auth
    this.#state = SessionState.DISCONNECTED;
    return false;
  }

  /**
   * Start a new authentication flow.
   * @param {object} [options] - Options passed to AuthFlow.initiate()
   * @returns {Promise<boolean>} Whether auth succeeded
   */
  async authenticate(options = {}) {
    this.#state = SessionState.AUTHENTICATING;
    eventBus.emit('session:authenticating', null, true);

    try {
      await authFlow.initiate(options);

      // Validate the new session
      const valid = await this.validate();
      if (!valid) {
        throw new Error('Auth completed but session validation failed');
      }

      this.#state = SessionState.CONNECTED;
      this.#startKeepalive();
      eventBus.emit('session:ready', { accounts: this.#accounts }, true);

      return true;
    } catch (err) {
      this.#state = SessionState.ERROR;
      handleError(classifyError(err, 'authenticate'));
      return false;
    }
  }

  /**
   * Validate current session by calling IBKR auth status endpoint.
   * @returns {Promise<boolean>} Whether session is valid
   */
  async validate() {
    try {
      const config = configLoader.getConfig();
      const baseUrl = configLoader.getApiBaseUrl();

      const response = await fetch(`${baseUrl}/iserver/auth/status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...cookieManager.getAuthHeaders()
        },
        credentials: 'include'
      });

      if (!response.ok) {
        log.warn(`Auth status check failed: HTTP ${response.status}`);
        return false;
      }

      const data = await response.json();
      log.debug('Auth status:', data);

      if (data.authenticated) {
        // Check for competing session
        if (data.competing) {
          this.#state = SessionState.COMPETING;
          log.warn('Competing session detected');
          eventBus.emit('session:competing', data, true);
        } else {
          this.#state = SessionState.CONNECTED;
        }

        // Fetch accounts if not already loaded
        if (this.#accounts.length === 0) {
          await this.#loadAccounts();
        }

        return true;
      }

      return false;
    } catch (err) {
      log.warn('Session validation failed:', err.message);
      return false;
    }
  }

  /**
   * Send keepalive (tickle) to prevent session timeout.
   * @returns {Promise<boolean>}
   */
  async tickle() {
    try {
      const baseUrl = configLoader.getApiBaseUrl();

      const response = await fetch(`${baseUrl}/tickle`, {
        method: 'POST',
        headers: cookieManager.getAuthHeaders(),
        credentials: 'include'
      });

      if (response.ok) {
        const data = await response.json();
        log.debug('Tickle response:', data);

        // Check session state from tickle response
        if (data.session) {
          if (data.session === 'expired') {
            log.warn('Session expired (tickle response)');
            this.#state = SessionState.DISCONNECTED;
            eventBus.emit('session:expired', null, true);
            this.#stopKeepalive();
            return false;
          }
        }
        return true;
      }

      return false;
    } catch (err) {
      log.warn('Tickle failed:', err.message);
      return false;
    }
  }

  /**
   * Logout — destroy session and clear all tokens.
   */
  async logout() {
    log.info('Logging out...');
    this.#stopKeepalive();

    try {
      const baseUrl = configLoader.getApiBaseUrl();
      await fetch(`${baseUrl}/logout`, {
        method: 'POST',
        headers: cookieManager.getAuthHeaders(),
        credentials: 'include'
      });
    } catch {
      // Best-effort logout
    }

    await cookieManager.clear();
    this.#state = SessionState.DISCONNECTED;
    this.#accounts = [];
    this.#accountId = null;

    eventBus.emit('session:destroyed', null, true);
    log.info('Logged out successfully');
  }

  /**
   * Switch the active account.
   * @param {string} accountId - Account ID to switch to
   */
  setActiveAccount(accountId) {
    if (this.#accounts.some(a => a.accountId === accountId || a.id === accountId)) {
      this.#accountId = accountId;
      eventBus.emit('session:account_changed', { accountId });
      log.info(`Active account set to: ${accountId}`);
    } else {
      log.warn(`Account ${accountId} not found in loaded accounts`);
    }
  }

  // --- Private ---

  #startKeepalive() {
    this.#stopKeepalive();
    const interval = configLoader.get('sessionKeepalive', 300000); // 5 min default

    this.#keepaliveTimer = setInterval(async () => {
      const ok = await this.tickle();
      if (!ok) {
        log.warn('Keepalive failed, session may be expiring');
      }
    }, interval);

    log.debug(`Keepalive started (every ${interval / 1000}s)`);
  }

  #stopKeepalive() {
    if (this.#keepaliveTimer) {
      clearInterval(this.#keepaliveTimer);
      this.#keepaliveTimer = null;
      log.debug('Keepalive stopped');
    }
  }

  async #loadAccounts() {
    try {
      const baseUrl = configLoader.getApiBaseUrl();

      const response = await fetch(`${baseUrl}/iserver/accounts`, {
        headers: cookieManager.getAuthHeaders(),
        credentials: 'include'
      });

      if (response.ok) {
        const data = await response.json();
        this.#accounts = data.accounts || [];
        if (this.#accounts.length > 0 && !this.#accountId) {
          this.#accountId = this.#accounts[0].accountId || this.#accounts[0].id || this.#accounts[0];
        }
        log.info(`Loaded ${this.#accounts.length} account(s), active: ${this.#accountId}`);
      }
    } catch (err) {
      log.warn('Failed to load accounts:', err.message);
    }
  }
}

// Singleton
const sessionManager = new SessionManager();

export { SessionManager, sessionManager, SessionState };
export default sessionManager;

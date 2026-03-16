/**
 * SFTi.IOS/server/gateway.js — IBKR Gateway Lifecycle Manager
 *
 * Manages the full lifecycle of the IBKR Client Portal Gateway
 * running **entirely in the browser** via CheerpJ 3.0.
 *
 * The key insight: the stock IBKR gateway (Vert.x / Netty) cannot run
 * in-browser because CheerpJ 3.0 cannot create TCP ServerSocket bindings.
 * Instead, we use BrowserGateway.java — a purpose-built Java class that
 * uses java.net.HttpURLConnection (which CheerpJ maps to the browser's
 * fetch API).  This lets the gateway proxy HTTP calls to api.ibkr.com
 * without any localhost server.
 *
 *   boot()                   → load CheerpJ JVM + BrowserGateway bridge
 *   authenticate()           → open IBKR SSO popup, poll for session
 *   loginWithCredentials()   → authenticate, then init brokerage session
 *   tickle()                 → keep session alive
 *   logout()                 → clear session
 *   getStatus()              → current gateway + auth state
 *   checkConnection()        → bridge reachability test
 */

import { getGateway } from '../../cheerpJ.local/cheerpj.js';
import { Vault } from '../storage/vault.js';

const SESSION_KEY = 'gw_session';
const TICKLE_INTERVAL_MS = 55_000;
const SSO_POLL_INTERVAL_MS = 2000;
const SSO_TIMEOUT_MS = 300_000; // 5 minutes
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000;

export class GatewayManager {
  constructor({ onLog, onError, onStatusChange } = {}) {
    this._onLog = onLog || console.log;
    this._onError = onError || console.error;
    this._onStatusChange = onStatusChange || (() => {});
    this._vault = new Vault('sfti.ios.server');
    this._gateway = null; // CheerpJLocal instance
    this._tickleTimer = null;
    this._status = 'idle'; // idle | booting | ready | awaiting_gateway | authenticated | error
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Boot sequence — load CheerpJ JVM and the BrowserGateway bridge.
   *
   * 1. Initialize CheerpJ 3.0 (WebAssembly JVM)
   * 2. Load all IBKR JARs via cheerpjRunLibrary()
   * 3. Resolve BrowserGateway class for Java-JS interop
   * 4. Initialize the bridge with IBKR API endpoints
   *
   * No localhost, no ServerSocket, no Netty — pure browser-native.
   */
  async boot() {
    if (this._status !== 'idle') return;
    this._setStatus('booting');

    this._onLog('[Gateway] Booting CheerpJ browser-native gateway…');

    try {
      this._gateway = getGateway({
        onLog:   (msg) => this._onLog(msg),
        onError: (err) => this._onLog('[Gateway] CheerpJ: ' + (err.message || err)),
        onReady: () => {
          if (this._status === 'booting' || this._status === 'awaiting_gateway') {
            this._setStatus('ready');
            this._onLog('[Gateway] Browser gateway bridge is ready.');
          }
        },
      });

      await this._gateway.boot();

      // Verify the bridge is alive
      if (this._gateway.bridge) {
        this._setStatus('ready');
        this._onLog('[Gateway] Connected — browser-native mode (no localhost).');
      } else {
        this._setStatus('awaiting_gateway');
        this._onLog('[Gateway] JVM loaded but bridge not yet available.');
      }
    } catch (err) {
      this._setStatus('awaiting_gateway');
      this._onLog('[Gateway] CheerpJ boot error: ' + (err.message || err));
      this._onLog('[Gateway] Retrying in background…');

      // Retry once after a delay
      setTimeout(() => this._retryBoot(), 5000);
    }
  }

  /**
   * Open the IBKR SSO login page in a popup and wait for authentication.
   *
   * The SSO login happens at gdcdyn.interactivebrokers.com.  After the user
   * logs in (username + password + 2FA), the session cookies are established.
   * We poll the Java bridge's authStatus() to detect when auth completes.
   *
   * @returns {Promise<boolean>}  true if authenticated
   */
  async authenticate() {
    if (this._status === 'idle') await this.boot();

    if (!this._gateway || !this._gateway.bridge) {
      throw new Error(
        'Gateway bridge not ready. CheerpJ JVM may still be loading. ' +
        'Please wait and try again.'
      );
    }

    this._onLog('[Gateway] Opening IBKR SSO login…');
    const loginUrl = await this._gateway.ssoLoginUrl();
    const ssoWindow = window.open(loginUrl, 'ibkr-sso',
      'width=600,height=700,scrollbars=yes,resizable=yes');

    return new Promise((resolve) => {
      let resolved = false;

      const finish = (result) => {
        if (resolved) return;
        resolved = true;
        clearInterval(pollTimer);
        clearTimeout(timeout);
        resolve(result);
      };

      const pollTimer = setInterval(async () => {
        try {
          if (ssoWindow && ssoWindow.closed) {
            await this._sleep(1500);
            const valid = await this._checkAuthStatus();
            finish(valid);
            return;
          }
        } catch (_) { /* cross-origin access — expected */ }

        const authed = await this._checkAuthStatus();
        if (authed) {
          try { ssoWindow?.close(); } catch (_) {}
          finish(true);
        }
      }, SSO_POLL_INTERVAL_MS);

      const timeout = setTimeout(() => {
        this._onLog('[Gateway] Login timed out after 5 minutes.');
        try { ssoWindow?.close(); } catch (_) {}
        finish(false);
      }, SSO_TIMEOUT_MS);
    });
  }

  /**
   * Login flow called from the UI when the user taps Sign In.
   *
   * @param {string} username
   * @param {string} password
   * @returns {Promise<boolean>}
   */
  async loginWithCredentials(username, password) {
    if (this._status === 'idle' || this._status === 'booting') await this.boot();

    const alreadyAuthed = await this._checkAuthStatus();
    if (alreadyAuthed) {
      this._onLog('[Gateway] Existing session detected.');
      return true;
    }

    const ok = await this.authenticate();
    if (ok) {
      await this._initBrokerageSession();
      this._startTickle();
      return true;
    }
    return false;
  }

  /** Send a keep-alive tickle via the Java bridge. */
  async tickle() {
    if (!this._gateway) return;
    try {
      const result = await this._gateway.tickle();
      if (result.status === 200) {
        try {
          const data = JSON.parse(result.body);
          if (data.session && data.ssoExpires) {
            this._onLog('[Gateway] Session alive, expires: ' + new Date(data.ssoExpires).toLocaleTimeString());
          }
        } catch (_) {}
      }
    } catch (_) { /* silent */ }
  }

  /** Logout and clear session. */
  async logout() {
    clearInterval(this._tickleTimer);
    this._tickleTimer = null;

    if (this._gateway) {
      try { await this._gateway.doLogout(); } catch (_) {}
    }

    await this._vault.delete(SESSION_KEY);

    if (this._gateway) await this._gateway.stop();
    this._gateway = null;
    this._setStatus('idle');
  }

  /** Return current status and session info. */
  async getStatus() {
    const session = await this._vault.get(SESSION_KEY);
    return {
      status: this._status,
      authenticated: this._status === 'authenticated',
      sessionExpiry: session?.expiry || null,
      bridgeReady: !!(this._gateway && this._gateway.bridge),
      mode: 'browser-native',
    };
  }

  /**
   * Public reachability check — tests if the Java bridge is alive.
   * @returns {Promise<boolean>}
   */
  async checkConnection() {
    if (!this._gateway || !this._gateway.bridge) return false;
    try {
      const isReady = await this._gateway.bridge.isReady();
      return !!isReady;
    } catch (_) {
      return false;
    }
  }

  /**
   * Proxy an arbitrary API request through the Java bridge.
   * @param {string} method  HTTP method
   * @param {string} path    API path (e.g. /v1/api/iserver/auth/status)
   * @param {string|null} body  JSON body
   * @returns {Promise<{status:number, body:string, error?:string}>}
   */
  async proxyRequest(method, path, body = null) {
    if (!this._gateway) throw new Error('Gateway not initialized');
    return this._gateway.proxyRequest(method, path, body);
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  async _retryBoot() {
    if (this._status !== 'awaiting_gateway') return;
    this._onLog('[Gateway] Retrying CheerpJ boot…');
    this._status = 'idle'; // Reset to allow re-boot
    try {
      await this.boot();
    } catch (_) {
      this._onLog('[Gateway] Retry failed. CheerpJ may not be supported in this browser.');
    }
  }

  async _checkAuthStatus() {
    if (!this._gateway || !this._gateway.bridge) return false;
    try {
      const result = await this._gateway.authStatus();
      if (result.status === 200) {
        const data = JSON.parse(result.body);
        if (data.authenticated) {
          const expiry = Date.now() + SESSION_DURATION_MS;
          await this._vault.set(SESSION_KEY, { expiry });
          this._setStatus('authenticated');
          return true;
        }
      }
    } catch (_) { /* bridge error */ }
    return false;
  }

  async _initBrokerageSession() {
    if (!this._gateway) return;
    try {
      const result = await this._gateway.ssoDHInit();
      if (result.status === 200) {
        this._onLog('[Gateway] Brokerage session initialized.');
      }
    } catch (_) {
      this._onLog('[Gateway] Brokerage session init skipped.');
    }
  }

  _startTickle() {
    if (this._tickleTimer) return;
    this._tickleTimer = setInterval(() => this.tickle(), TICKLE_INTERVAL_MS);
  }

  _setStatus(s) {
    this._status = s;
    this._onStatusChange(s);
  }

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
}

export default GatewayManager;

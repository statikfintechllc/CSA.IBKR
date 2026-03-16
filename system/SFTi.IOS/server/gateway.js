/**
 * SFTi.IOS/server/gateway.js — IBKR Gateway Lifecycle Manager
 *
 * Manages the full lifecycle of the IBKR Client Portal Gateway:
 *
 *   boot()                   → start the in-browser JVM via CheerpJ 3.0,
 *                              then verify the gateway is reachable
 *   authenticate()           → open the gateway's login page (IBKR SSO),
 *                              poll for session
 *   loginWithCredentials()   → authenticate, then init brokerage session
 *   tickle()                 → keep the session alive (POST /tickle every 55s)
 *   logout()                 → clear session + stop JVM
 *   getStatus()              → current gateway + auth state
 *
 * CheerpJ 3.0 (loaded from CDN in index.html) provides the WebAssembly
 * JVM that runs the IBKR gateway JAR entirely in the browser.  The JVM
 * boots automatically — the user only needs to add the PWA to their
 * home screen and sign in.
 */

import { getGateway } from '../../cheerpJ.local/cheerpj.js';
import { Vault } from '../storage/vault.js';

const SESSION_KEY = 'gw_session';
const GATEWAY_URL_KEY = 'gw_base_url';
const TICKLE_INTERVAL_MS = 55_000;
const SSO_POLL_INTERVAL_MS = 2000;
const SSO_TIMEOUT_MS = 300_000; // 5 minutes
const PING_TIMEOUT_MS = 6000;

const DEFAULT_GATEWAY_URL = 'https://localhost:5000';
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000;

export class GatewayManager {
  constructor({ onLog, onError, onStatusChange } = {}) {
    this._onLog = onLog || console.log;
    this._onError = onError || console.error;
    this._onStatusChange = onStatusChange || (() => {});
    this._vault = new Vault('sfti.ios.server');
    this._gateway = null;
    this._tickleTimer = null;
    this._status = 'idle'; // idle | booting | ready | awaiting_gateway | authenticated | error
    this._gatewayBaseUrl = DEFAULT_GATEWAY_URL;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Boot the in-browser JVM gateway via CheerpJ 3.0, then verify reachability.
   *
   * The user does not need to do anything — CheerpJ loads from CDN,
   * initialises the WebAssembly JVM, and launches the gateway JAR
   * automatically.  JARs are served by GitHub Pages (Jekyll) and
   * cached in the client-side vault (OPFS) for offline support.
   */
  async boot() {
    if (this._status !== 'idle') return;
    this._setStatus('booting');

    // Restore persisted gateway URL (if user previously set one)
    const savedUrl = await this._vault.get(GATEWAY_URL_KEY);
    if (savedUrl) this._gatewayBaseUrl = savedUrl;

    // Boot the CheerpJ JVM — this prefetches all JARs into OPFS,
    // then calls cheerpjInit() + cheerpjRunMain() to start the gateway.
    try {
      this._gateway = getGateway({
        onLog: (msg) => this._onLog(msg),
        onError: (msg) => this._onError(msg),
        onReady: () => {
          this._onLog('[Gateway] CheerpJ JVM started gateway successfully.');
        },
      });

      await this._gateway.boot();
    } catch (err) {
      this._onLog('[Gateway] CheerpJ boot error: ' + (err.message || err));
    }

    // Notify SW of the gateway URL for API proxying
    await this._notifySW('SET_GATEWAY_URL', { url: this._gatewayBaseUrl });

    // Check if the gateway is actually reachable (may be CheerpJ or external)
    const reachable = await this._pingGateway();
    if (reachable) {
      this._setStatus('ready');
      this._onLog('[Gateway] Gateway reachable at ' + this._gatewayBaseUrl);
    } else {
      this._setStatus('awaiting_gateway');
      this._onLog('[Gateway] Gateway JVM active but HTTP endpoint not reachable from browser.');
    }
  }

  /**
   * Open the Client Portal Gateway login page and wait for authentication.
   *
   * Per GettingStarted.md:
   *   1. Navigate to the gateway URL (e.g. https://localhost:5000)
   *   2. Gateway redirects to IBKR SSO for login + 2FA
   *   3. After SSO, IBKR redirects BACK to the gateway with a session token
   *   4. The gateway confirms authentication
   *
   * @returns {Promise<boolean>}  true if authenticated
   */
  async authenticate() {
    if (this._status === 'idle') await this.boot();

    // Pre-flight: try to reach the gateway before opening a popup
    const reachable = await this._pingGateway();
    if (!reachable) {
      throw new Error(
        'Gateway not reachable. The CheerpJ JVM started the gateway, but ' +
        'the HTTP endpoint is not accessible from the browser. ' +
        'Ensure the self-signed certificate is accepted at ' + this._gatewayBaseUrl
      );
    }

    this._onLog('[Gateway] Opening IBKR SSO login…');
    const loginUrl = this._gatewayBaseUrl;
    const ssoWindow = window.open(loginUrl, 'ibkr-sso');

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

  /** Send a keep-alive tickle to the gateway. */
  async tickle() {
    try {
      const resp = await fetch(`${this._gatewayBaseUrl}/v1/api/tickle`, {
        method: 'POST',
        credentials: 'include',
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.session && data.ssoExpires) {
          this._onLog('[Gateway] Session alive, expires: ' + new Date(data.ssoExpires).toLocaleTimeString());
        }
      }
    } catch (_) { /* silent */ }
  }

  /** Logout and stop the gateway JVM. */
  async logout() {
    clearInterval(this._tickleTimer);
    this._tickleTimer = null;

    try {
      await fetch(`${this._gatewayBaseUrl}/v1/api/logout`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch (_) { /* silent */ }

    await this._notifySW('CLEAR_SESSION');
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
      gatewayUrl: this._gatewayBaseUrl,
    };
  }

  /**
   * Public reachability check.
   * @returns {Promise<boolean>}
   */
  async checkConnection() {
    return this._pingGateway();
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  async _pingGateway() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
    try {
      await fetch(this._gatewayBaseUrl, {
        method: 'GET',
        mode: 'no-cors',
        credentials: 'include',
        signal: controller.signal,
      });
      clearTimeout(timer);
      return true;
    } catch (_) {
      clearTimeout(timer);
      return false;
    }
  }

  async _checkAuthStatus() {
    try {
      const resp = await fetch(`${this._gatewayBaseUrl}/v1/api/iserver/auth/status`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!resp.ok) return false;
      const data = await resp.json();
      if (data.authenticated) {
        const expiry = Date.now() + SESSION_DURATION_MS;
        await this._vault.set(SESSION_KEY, { expiry });
        await this._notifySW('SET_SESSION', { expiry });
        this._setStatus('authenticated');
        return true;
      }
    } catch (_) { /* gateway unreachable */ }
    return false;
  }

  async _initBrokerageSession() {
    try {
      const resp = await fetch(`${this._gatewayBaseUrl}/v1/api/iserver/auth/ssodh/init`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publish: true, compete: true }),
      });
      if (resp.ok) {
        this._onLog('[Gateway] Brokerage session initialized.');
      }
    } catch (_) {
      this._onLog('[Gateway] Brokerage session init skipped (gateway unreachable).');
    }
  }

  async _notifySW(type, payload) {
    try {
      const sw = await navigator.serviceWorker.ready;
      sw.active.postMessage({ type, payload });
    } catch (_) { /* SW not available */ }
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

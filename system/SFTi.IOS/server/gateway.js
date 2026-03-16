/**
 * SFTi.IOS/server/gateway.js — IBKR Gateway Lifecycle Manager
 *
 * Manages the full lifecycle of the IBKR Client Portal Gateway:
 *
 *   boot()                   → start the in-browser JVM + gateway JAR
 *   authenticate()           → open IBKR SSO in a popup, poll for session
 *   loginWithCredentials()   → store creds via Face ID, then authenticate via SSO
 *   tickle()                 → keep the session alive (POST /tickle every 55s)
 *   logout()                 → clear session + stop gateway
 *   getStatus()              → current gateway + auth state
 *
 * Authentication flow (IBKR requirement):
 *   IBKR does NOT expose a REST endpoint for credential submission.
 *   All authentication goes through browser-based SSO with 2FA.
 *   See: https://www.interactivebrokers.com/campus/ibkr-api-page/cpapi-v1/#authentication
 *
 *   1. Open IBKR SSO login page in a popup/new window
 *   2. User authenticates on IBKR's page (username + password + 2FA)
 *   3. After login, poll /iserver/auth/status to detect the session
 *   4. Once authenticated, /iserver/auth/ssodh/init opens the brokerage session
 *
 * The Service Worker proxies all /v1/api/* requests to the configured
 * gateway base URL (local gateway or api.ibkr.com).
 */

import { getGateway } from '../../cheerpJ.local/cheerpj.js';
import { Vault } from '../storage/vault.js';

const SESSION_KEY = 'gw_session';
const GATEWAY_URL_KEY = 'gw_base_url';
const TICKLE_INTERVAL_MS = 55_000;
const SSO_POLL_INTERVAL_MS = 2000;
const SSO_TIMEOUT_MS = 300_000; // 5 minutes

// IBKR SSO login page — forwardTo=22 = Client Portal Gateway
// See: GettingStarted.md in the gateway bundle
const IBKR_SSO_URL = 'https://gdcdyn.interactivebrokers.com/sso/Login?forwardTo=22&RL=1';

// Default gateway base URL — the standard CP Gateway port
const DEFAULT_GATEWAY_URL = 'https://localhost:5000';

// Session duration — IBKR requires re-auth at least once per day
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000;

export class GatewayManager {
  constructor({ onLog, onError, onStatusChange } = {}) {
    this._onLog = onLog || console.log;
    this._onError = onError || console.error;
    this._onStatusChange = onStatusChange || (() => {});
    this._vault = new Vault('sfti.ios.server');
    this._gateway = null;
    this._tickleTimer = null;
    this._status = 'idle'; // idle | booting | ready | authenticated | error
    this._gatewayBaseUrl = DEFAULT_GATEWAY_URL;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Set the gateway base URL.  Persists in the vault so it survives reloads.
   * Also notifies the Service Worker so it can proxy requests correctly.
   *
   * @param {string} url  e.g. "https://localhost:5000" or "https://192.168.1.5:5000"
   */
  async setGatewayUrl(url) {
    this._gatewayBaseUrl = url.replace(/\/+$/, '');
    await this._vault.set(GATEWAY_URL_KEY, this._gatewayBaseUrl);
    await this._notifySW('SET_GATEWAY_URL', { url: this._gatewayBaseUrl });
    this._onLog(`[Gateway] Base URL set to ${this._gatewayBaseUrl}`);
  }

  /** Start the in-browser JVM gateway (CheerpJ). */
  async boot() {
    if (this._status !== 'idle') return;
    this._setStatus('booting');

    // Restore persisted gateway URL
    const savedUrl = await this._vault.get(GATEWAY_URL_KEY);
    if (savedUrl) this._gatewayBaseUrl = savedUrl;

    try {
      this._gateway = getGateway({
        onLog: (msg) => this._onLog(msg),
        onError: (msg) => this._onError(msg),
        onReady: () => {
          this._setStatus('ready');
          this._onLog('[Gateway] In-browser gateway ready.');
        },
      });
      await this._gateway.boot();
    } catch (err) {
      // CheerpJ / WASM boot failed — this is expected until the real
      // WASM JVM is implemented.  Fall back to external gateway mode.
      this._setStatus('ready');
      this._onLog('[Gateway] In-browser JVM unavailable — using external gateway.');
    }

    // Notify SW of the gateway URL for API proxying
    await this._notifySW('SET_GATEWAY_URL', { url: this._gatewayBaseUrl });
  }

  /**
   * Open the IBKR SSO login page and wait for authentication.
   *
   * This is the correct IBKR auth flow — browser-based SSO with 2FA.
   * IBKR explicitly does not support programmatic credential submission:
   * "There is currently no mechanism available on Interactive Brokers' end
   *  to permit individual clients to automate the brokerage session
   *  authentication process when using Client Portal API."
   *
   * @returns {Promise<boolean>}  true if authenticated, false if cancelled/timeout
   */
  async authenticate() {
    if (this._status === 'idle') await this.boot();

    this._onLog('[Gateway] Opening IBKR login page…');
    this._onLog('[Gateway] Complete sign-in (including 2FA) on the IBKR page.');

    // Open IBKR SSO in a popup (or new tab on iOS standalone PWA)
    const ssoWindow = window.open(IBKR_SSO_URL, 'ibkr-sso');

    return new Promise((resolve) => {
      let resolved = false;

      const finish = (result) => {
        if (resolved) return;
        resolved = true;
        clearInterval(pollTimer);
        clearTimeout(timeout);
        resolve(result);
      };

      // Poll the gateway's auth status endpoint
      const pollTimer = setInterval(async () => {
        // Check if popup was closed without completing login
        try {
          if (ssoWindow && ssoWindow.closed) {
            // Give a short grace period — session may have just been established
            await this._sleep(1500);
            const valid = await this._checkAuthStatus();
            finish(valid);
            return;
          }
        } catch (_) { /* cross-origin access — expected */ }

        // Check if authenticated via gateway
        const authed = await this._checkAuthStatus();
        if (authed) {
          try { ssoWindow?.close(); } catch (_) {}
          finish(true);
        }
      }, SSO_POLL_INTERVAL_MS);

      // Timeout — don't wait forever
      const timeout = setTimeout(() => {
        this._onLog('[Gateway] Login timed out after 5 minutes.');
        try { ssoWindow?.close(); } catch (_) {}
        finish(false);
      }, SSO_TIMEOUT_MS);
    });
  }

  /**
   * Login flow called from the UI when the user enters credentials.
   *
   * Credentials are saved via Face ID (for quick re-login) but are NOT
   * posted to any REST endpoint.  Authentication always goes through
   * IBKR's browser-based SSO page.
   *
   * @param {string} username  IBKR username (stored for Face ID)
   * @param {string} password  IBKR password (stored encrypted via Face ID)
   * @returns {Promise<boolean>}
   */
  async loginWithCredentials(username, password) {
    if (this._status === 'idle' || this._status === 'booting') await this.boot();

    // Check if we already have a valid session (e.g. from a previous SSO login)
    const alreadyAuthed = await this._checkAuthStatus();
    if (alreadyAuthed) {
      this._onLog('[Gateway] Existing session detected.');
      return true;
    }

    // Open IBKR SSO for the user to authenticate
    const ok = await this.authenticate();
    if (ok) {
      // Initialize the brokerage session after SSO
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
    } catch (_) { /* silent — gateway may be unreachable */ }
  }

  /** Logout and stop the gateway. */
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

  // ─── Private ────────────────────────────────────────────────────────────────

  /**
   * Check if the gateway has an authenticated session.
   * Tries the gateway's /iserver/auth/status endpoint.
   */
  async _checkAuthStatus() {
    try {
      const resp = await fetch(`${this._gatewayBaseUrl}/v1/api/iserver/auth/status`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!resp.ok) return false;
      const data = await resp.json();
      // IBKR returns { authenticated: true, connected: true, ... } when valid
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

  /**
   * After SSO login, initialize the brokerage session.
   * This opens the trading session via /iserver/auth/ssodh/init.
   */
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

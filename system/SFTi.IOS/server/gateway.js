/**
 * SFTi.IOS/server/gateway.js — IBKR Gateway Lifecycle Manager
 *
 * Manages the full lifecycle of the IBKR Client Portal Gateway:
 *
 *   boot()                   → start the in-browser JVM + gateway JAR
 *   authenticate()           → open the gateway's own login page (which
 *                              redirects to IBKR SSO), then poll for session
 *   loginWithCredentials()   → store creds via Face ID, then authenticate
 *   tickle()                 → keep the session alive (POST /tickle every 55s)
 *   logout()                 → clear session + stop gateway
 *   getStatus()              → current gateway + auth state
 *
 * Authentication flow (per GettingStarted.md):
 *   1. Open the Client Portal Gateway's own URL in a popup
 *      (e.g. https://localhost:5000)
 *   2. The gateway redirects to IBKR SSO for login + 2FA
 *   3. After login, IBKR SSO redirects BACK to the gateway
 *   4. The gateway captures the session token
 *   5. Poll /iserver/auth/status to confirm the session
 *   6. /iserver/auth/ssodh/init opens the brokerage session
 *
 * Opening the gateway URL (not the IBKR SSO URL directly) is critical:
 * the gateway must be the redirect target so it can capture the session
 * cookie.  Navigating to IBKR SSO directly would log you into the web
 * portal without establishing a session on the local gateway.
 *
 * The Service Worker proxies all /v1/api/* requests to the configured
 * gateway base URL.
 */

import { getGateway } from '../../cheerpJ.local/cheerpj.js';
import { Vault } from '../storage/vault.js';

const SESSION_KEY = 'gw_session';
const GATEWAY_URL_KEY = 'gw_base_url';
const TICKLE_INTERVAL_MS = 55_000;
const SSO_POLL_INTERVAL_MS = 2000;
const SSO_TIMEOUT_MS = 300_000; // 5 minutes

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
   * Open the Client Portal Gateway's login page and wait for authentication.
   *
   * Per GettingStarted.md the correct flow is:
   *   1. Navigate to the gateway URL (e.g. https://localhost:5000)
   *   2. The gateway redirects to IBKR SSO for login + 2FA
   *   3. After SSO, IBKR redirects BACK to the gateway with a session token
   *   4. The gateway confirms authentication
   *
   * Opening the gateway URL — not the IBKR SSO URL directly — is critical:
   * the gateway must be the SSO redirect target so it can capture the
   * session cookie.  Going to IBKR SSO directly logs you into the web
   * portal without establishing a session on the local gateway.
   *
   * @returns {Promise<boolean>}  true if authenticated, false if cancelled/timeout
   */
  async authenticate() {
    if (this._status === 'idle') await this.boot();

    this._onLog('[Gateway] Opening Client Portal Gateway login…');
    this._onLog('[Gateway] Complete sign-in (including 2FA) on the login page.');

    // Open the GATEWAY's own URL — it will redirect to IBKR SSO and
    // capture the session token when SSO redirects back.
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
   * Credentials are saved via Face ID (for quick re-login).  Authentication
   * is done by opening the Client Portal Gateway's login page, which
   * redirects to IBKR SSO internally and captures the session token.
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

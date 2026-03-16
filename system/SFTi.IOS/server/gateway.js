/**
 * SFTi.IOS/server/gateway.js — IBKR Gateway Lifecycle Manager
 *
 * Manages the full lifecycle of the IBKR Client Portal Gateway running
 * inside the browser via CheerpJ.local:
 *
 *   boot()       → start the JVM + gateway JAR
 *   login()      → redirect to IBKR OAuth login page
 *   tickle()     → keep the session alive (POST /v1/api/tickle every 55s)
 *   logout()     → clear session + stop gateway
 *   getStatus()  → current gateway + auth state
 *
 * The Service Worker handles token injection; this module coordinates
 * the higher-level lifecycle that the main UI thread observes.
 */

import { getGateway } from '../../cheerpJ.local/cheerpj.js';
import { Vault } from '../storage/vault.js';

const SESSION_KEY = 'gw_session';
const TICKLE_INTERVAL_MS = 55_000;
const IBKR_AUTH_URL = 'https://www.interactivebrokers.com/sso/Login?forwardTo=22';

export class GatewayManager {
  constructor({ onLog, onError, onStatusChange } = {}) {
    this._onLog = onLog || console.log;
    this._onError = onError || console.error;
    this._onStatusChange = onStatusChange || (() => {});
    this._vault = new Vault('sfti.ios.server');
    this._gateway = null;
    this._tickleTimer = null;
    this._status = 'idle'; // idle | booting | ready | authenticated | error
  }

  /** Start the JVM gateway. */
  async boot() {
    if (this._status !== 'idle') return;
    this._setStatus('booting');

    try {
      this._gateway = getGateway({
        onLog: (msg) => this._onLog(msg),
        onError: (msg) => this._onError(msg),
        onReady: () => {
          this._setStatus('ready');
          this._startTickle();
        },
      });
      await this._gateway.boot();
    } catch (err) {
      this._setStatus('error');
      this._onError('[GatewayManager] Boot failed:', err);
    }
  }

  /**
   * Redirect the user to the IBKR login page.
   * The Service Worker intercepts the OAuth callback and posts a
   * SET_SESSION message, which wakes the session listener registered here.
   */
  async login() {
    if (this._status === 'idle') await this.boot();

    return new Promise((resolve) => {
      const handler = (event) => {
        const { type, payload } = event.data || {};
        if (type === 'SESSION_READY') {
          navigator.serviceWorker.removeEventListener('message', handler);
          this._vault.set(SESSION_KEY, { token: payload?.token, expiry: payload?.expiry });
          this._setStatus('authenticated');
          resolve(true);
        }
      };
      navigator.serviceWorker.addEventListener('message', handler);

      // Open IBKR login in a new tab — SW catches the OAuth callback redirect
      // and posts SESSION_READY back to all clients (including this one).
      // We use window.open() rather than window.location.href so this JS
      // context (and the message listener above) stay alive.
      // Derive the app root universally — works from any subdirectory.
      const appRoot = new URL('./', location.href).href;
      window.open(
        `${IBKR_AUTH_URL}&redirect_uri=${encodeURIComponent(appRoot)}`,
        '_blank',
        'noopener'
      );
    });
  }

  /**
   * Programmatic login using username/password (for Face ID auto-login flow).
   * POSTs to the local gateway's /v1/api/iserver/auth/ssodh2 endpoint.
   *
   * @param {string} username
   * @param {string} password
   */
  async loginWithCredentials(username, password) {
    if (this._status === 'idle' || this._status === 'booting') await this.boot();

    try {
      const resp = await fetch('/v1/api/iserver/auth/ssodh2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
        credentials: 'include',
      });

      if (!resp.ok) throw new Error(`Auth failed: ${resp.status}`);

      const data = await resp.json();
      const token = data.access_token || data.oauth_token;

      if (token) {
        const expiry = Date.now() + 24 * 60 * 60 * 1000;
        // Notify Service Worker
        const sw = await navigator.serviceWorker.ready;
        sw.active.postMessage({ type: 'SET_SESSION', payload: { token, expiry } });
        await this._vault.set(SESSION_KEY, { token, expiry });
        this._setStatus('authenticated');
        return true;
      }
    } catch (err) {
      this._onError('[GatewayManager] loginWithCredentials failed:', err);
    }
    return false;
  }

  /** Send a keep-alive tickle to the gateway. */
  async tickle() {
    try {
      await fetch('/v1/api/tickle', { method: 'POST', credentials: 'include' });
    } catch (_) { /* silent */ }
  }

  /** Logout and stop the gateway. */
  async logout() {
    clearInterval(this._tickleTimer);
    this._tickleTimer = null;

    try {
      await fetch('/v1/api/logout', { method: 'POST', credentials: 'include' });
    } catch (_) { /* silent */ }

    const sw = await navigator.serviceWorker.ready;
    sw.active.postMessage({ type: 'CLEAR_SESSION' });

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
    };
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  _startTickle() {
    if (this._tickleTimer) return;
    this._tickleTimer = setInterval(() => this.tickle(), TICKLE_INTERVAL_MS);
  }

  _setStatus(s) {
    this._status = s;
    this._onStatusChange(s);
  }
}

export default GatewayManager;

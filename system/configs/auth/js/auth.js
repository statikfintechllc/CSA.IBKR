/**
 * configs/auth/js/auth.js
 * Authentication controller — coordinates Face ID, gateway boot, and
 * login UI state machine.
 */

import FaceID from '../../../SFTi.IOS/face/faceid.js';
import { GatewayManager } from '../../../SFTi.IOS/server/gateway.js';

export class AuthController {
  /**
   * @param {object} opts
   * @param {function} opts.onAuthenticated  Called on successful auth
   * @param {function} opts.onError          Called on auth failure
   * @param {function} opts.onStatusChange   Called with human-readable status text
   */
  constructor({ onAuthenticated, onError, onStatusChange } = {}) {
    this._onAuthenticated = onAuthenticated || (() => {});
    this._onError = onError || console.error;
    this._onStatusChange = onStatusChange || (() => {});

    this._faceID = new FaceID();
    this._gateway = new GatewayManager({
      onLog: (m) => this._onStatusChange(m),
      onError: this._onError,
      onStatusChange: (s) => {
        if (s === 'authenticated') this._onAuthenticated();
      },
    });
  }

  /**
   * Attempt to auto-login using stored Face ID credential.
   * Returns true if successful; false if manual login required.
   *
   * @returns {Promise<boolean>}
   */
  async tryAutoLogin() {
    if (!(await this._faceID.hasCredential())) return false;

    this._onStatusChange('Verifying Face ID…');
    try {
      const creds = await this._faceID.authenticate();
      if (!creds) return false;

      this._onStatusChange('Starting gateway…');
      return await this._gateway.loginWithCredentials(creds.username, creds.password);
    } catch (err) {
      this._onError('Auto-login failed:', err);
      return false;
    }
  }

  /**
   * Manual login: register Face ID for the first time, then log in.
   *
   * @param {string} username
   * @param {string} password
   */
  async manualLogin(username, password) {
    this._onStatusChange('Registering Face ID…');
    try {
      await this._faceID.register(username, password);
    } catch (err) {
      // Face ID registration failed — continue without it
      this._onError('Face ID registration skipped:', err.message);
    }

    this._onStatusChange('Connecting to IBKR gateway…');
    const ok = await this._gateway.loginWithCredentials(username, password);
    if (!ok) throw new Error('Login failed. Please check your IBKR credentials.');
  }

  /**
   * Logout and clear all credentials.
   */
  async logout() {
    await this._gateway.logout();
    await this._faceID.clearCredential();
  }

  get gateway() { return this._gateway; }
}

export default AuthController;

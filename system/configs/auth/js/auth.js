/**
 * configs/auth/js/auth.js
 * Authentication controller — coordinates Face ID, gateway boot, and
 * login UI state machine.
 *
 * Auth flow:
 *   1. Face ID auto-login: retrieve stored creds → validate existing session
 *   2. Manual login: save creds via Face ID → open gateway login page
 *      (gateway redirects to IBKR SSO internally → captures session token)
 *
 * Credentials are stored encrypted via Face ID for future auto-login
 * once the in-browser CheerpJ gateway is fully operational.
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

      // Boot the gateway and check for an existing session
      this._onStatusChange('Checking session…');
      return await this._gateway.loginWithCredentials(creds.username, creds.password);
    } catch (err) {
      this._onError('Auto-login failed:', err);
      return false;
    }
  }

  /**
   * Manual login: register Face ID for the first time, then authenticate
   * via the Client Portal Gateway's login page (which redirects to IBKR SSO
   * internally and captures the session token).
   *
   * @param {string} username  IBKR username
   * @param {string} password  IBKR password
   */
  async manualLogin(username, password) {
    // Step 1: Save credentials via Face ID for future auto-login
    this._onStatusChange('Registering Face ID…');
    try {
      await this._faceID.register(username, password);
    } catch (err) {
      // Face ID registration failed — continue without it
      this._onError('Face ID registration skipped:', err.message);
    }

    // Step 2: Authenticate via Client Portal Gateway
    this._onStatusChange('Opening Client Portal Gateway login…');
    const ok = await this._gateway.loginWithCredentials(username, password);
    if (!ok) {
      throw new Error(
        'Login was not completed. Please sign in on the gateway login page (including 2FA) and try again.'
      );
    }
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

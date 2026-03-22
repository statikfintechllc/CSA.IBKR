/**
 * CSA.IBKR — Auth Flow (Bridge Layer)
 * Replaces: ibgroup.security.auth.client.lib
 *
 * Orchestrates the IBKR SSO login flow using popup window + postMessage.
 * Handles the full cycle: open popup → user authenticates → extract tokens → close.
 */

import logger from '../engine/logger.js';
import eventBus from '../engine/event-bus.js';
import configLoader from '../engine/config-loader.js';
import cookieManager from './cookie-manager.js';

const log = logger.child('AuthFlow');

// Auth flow states
const AuthState = Object.freeze({
  IDLE: 'IDLE',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED'
});

class AuthFlow {
  #state = AuthState.IDLE;
  #popup = null;
  #pollTimer = null;
  #messageHandler = null;

  /**
   * Get current auth state.
   * @returns {string} AuthState value
   */
  get state() {
    return this.#state;
  }

  /**
   * Initiate the IBKR SSO login flow.
   * Opens a popup window to the IBKR login page.
   * Resolves when authentication is complete.
   *
   * @param {object} [options]
   * @param {string} [options.callbackUrl] - Override callback URL
   * @param {number} [options.timeout=300000] - Auth timeout (5 min default)
   * @param {number} [options.popupWidth=500]
   * @param {number} [options.popupHeight=700]
   * @returns {Promise<object>} Session tokens
   */
  async initiate(options = {}) {
    if (this.#state === AuthState.IN_PROGRESS) {
      throw new Error('Auth flow already in progress');
    }

    this.#state = AuthState.IN_PROGRESS;
    log.info('Initiating IBKR SSO auth flow...');
    eventBus.emit('session:auth_started');

    const config = configLoader.getConfig();
    const callbackUrl = options.callbackUrl || this.#getCallbackUrl();
    const timeout = options.timeout || 300000;

    try {
      // Build IBKR SSO login URL
      const loginUrl = this.#buildLoginUrl(config, callbackUrl);
      log.debug('Login URL:', loginUrl);

      // Open popup window
      this.#popup = this.#openPopup(loginUrl, options.popupWidth || 500, options.popupHeight || 700);

      if (!this.#popup) {
        throw new Error('Popup blocked by browser. Please allow popups for this site.');
      }

      // Wait for auth to complete via multiple detection methods
      const tokens = await Promise.race([
        this.#listenForCallback(callbackUrl),
        this.#pollPopupUrl(callbackUrl),
        this.#timeout(timeout)
      ]);

      this.#state = AuthState.COMPLETED;
      log.info('Auth flow completed successfully');
      eventBus.emit('session:auth_completed', tokens);

      return tokens;
    } catch (err) {
      this.#state = AuthState.FAILED;
      log.error('Auth flow failed:', err.message);
      eventBus.emit('session:auth_failed', { error: err.message });
      throw err;
    } finally {
      this.#cleanup();
    }
  }

  /**
   * Cancel an in-progress auth flow.
   */
  cancel() {
    if (this.#state === AuthState.IN_PROGRESS) {
      log.info('Auth flow cancelled');
      this.#state = AuthState.IDLE;
      this.#cleanup();
      eventBus.emit('session:auth_cancelled');
    }
  }

  // --- Private ---

  #buildLoginUrl(config, callbackUrl) {
    const base = config.ssoLoginUrl;
    const params = new URLSearchParams({
      forwardTo: String(config.ssoForwardTo || 22),
      RL: '1',
      ip2loc: config.region || 'US'
    });

    // Add callback redirect if IBKR supports it
    // Note: IBKR's SSO flow may use different redirect mechanisms
    if (callbackUrl) {
      params.set('redirect', callbackUrl);
    }

    return `${base}?${params.toString()}`;
  }

  #getCallbackUrl() {
    // Generate callback URL based on current origin
    // GitHub Pages: https://<user>.github.io/<repo>/auth/callback
    const base = window.location.origin + window.location.pathname.replace(/\/[^/]*$/, '');
    return `${base}/auth/callback.html`;
  }

  #openPopup(url, width, height) {
    const left = Math.max(0, (screen.width - width) / 2);
    const top = Math.max(0, (screen.height - height) / 2);

    const features = [
      `width=${width}`,
      `height=${height}`,
      `left=${left}`,
      `top=${top}`,
      'menubar=no',
      'toolbar=no',
      'location=yes',
      'status=yes',
      'resizable=yes',
      'scrollbars=yes'
    ].join(',');

    return window.open(url, 'ibkr_auth', features);
  }

  /**
   * Listen for postMessage from the popup callback page.
   */
  #listenForCallback(callbackUrl) {
    return new Promise((resolve, reject) => {
      this.#messageHandler = async (event) => {
        // Validate origin — accept messages from our own origin
        // or from IBKR's domain
        const trustedOrigins = [
          window.location.origin,
          'https://gdcdyn.interactivebrokers.com',
          'https://api.ibkr.com',
          'https://ndcdyn.interactivebrokers.com'
        ];

        if (!trustedOrigins.includes(event.origin)) {
          return; // Ignore untrusted origins
        }

        if (event.data && event.data.type === 'ibkr_auth_callback') {
          log.debug('Received auth callback via postMessage');

          // Extract tokens from callback data
          const tokens = await cookieManager.extractFromCallback(
            event.data.callbackUrl || event.data.url || ''
          );

          // Also check for direct token data
          if (event.data.tokens) {
            Object.assign(tokens, event.data.tokens);
          }

          resolve(tokens);
        }
      };

      window.addEventListener('message', this.#messageHandler);
    });
  }

  /**
   * Poll the popup window's URL to detect when it reaches our callback.
   * This works when postMessage isn't available.
   */
  #pollPopupUrl(callbackUrl) {
    return new Promise((resolve, reject) => {
      this.#pollTimer = setInterval(async () => {
        if (!this.#popup || this.#popup.closed) {
          clearInterval(this.#pollTimer);
          reject(new Error('Auth popup was closed by user'));
          return;
        }

        try {
          const popupUrl = this.#popup.location.href;

          // Check if popup navigated to our callback URL
          if (popupUrl && popupUrl.startsWith(callbackUrl)) {
            log.debug('Popup reached callback URL');
            clearInterval(this.#pollTimer);

            const tokens = await cookieManager.extractFromCallback(popupUrl);
            this.#popup.close();
            resolve(tokens);
          }
        } catch {
          // Cross-origin — can't read popup URL yet.
          // This is expected while the user is on IBKR's login page.
        }
      }, 500);
    });
  }

  #timeout(ms) {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Auth flow timed out after ${ms / 1000}s`));
      }, ms);
    });
  }

  #cleanup() {
    if (this.#popup && !this.#popup.closed) {
      this.#popup.close();
    }
    this.#popup = null;

    if (this.#pollTimer) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }

    if (this.#messageHandler) {
      window.removeEventListener('message', this.#messageHandler);
      this.#messageHandler = null;
    }
  }
}

// Singleton
const authFlow = new AuthFlow();

export { AuthFlow, authFlow, AuthState };
export default authFlow;

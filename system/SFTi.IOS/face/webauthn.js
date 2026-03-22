/**
 * CSA.IBKR — WebAuthn / Face ID Integration (SFTi.IOS)
 * 
 * WebAuthn (FIDO2) integration for Face ID / Touch ID login.
 * On iOS 26.4 Safari (Home Screen PWA), this triggers the
 * Secure Enclave for biometric verification.
 *
 * Flow:
 *   1. First login: user enters IBKR credentials normally
 *   2. After auth: call register() → iPhone prompts Face ID
 *   3. Device creates keypair in Secure Enclave
 *   4. Future logins: call authenticate() → Face ID → auto-unlock vault
 */

import logger from '../../IBKR.CSA/engine/logger.js';
import eventBus from '../../IBKR.CSA/engine/event-bus.js';

const log = logger.child('WebAuthn');

// Relying Party configuration
const RP_ID_AUTO = typeof window !== 'undefined' ? window.location.hostname : 'localhost';

class WebAuthnManager {
  #rpId = RP_ID_AUTO;
  #rpName = 'CSA.IBKR Trading';
  #credentialId = null;

  /**
   * Check if WebAuthn is available on this device.
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    if (typeof window === 'undefined') return false;
    if (!window.PublicKeyCredential) return false;

    try {
      // Check for platform authenticator (Face ID / Touch ID)
      const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
      return available;
    } catch {
      return false;
    }
  }

  /**
   * Register a new passkey (called after first successful IBKR login).
   * This triggers Face ID on iOS and creates a credential in Secure Enclave.
   * 
   * @param {string} userId - IBKR username or account ID
   * @param {string} displayName - Human-readable name
   * @returns {Promise<ArrayBuffer>} Raw credential ID (for vault key derivation)
   */
  async register(userId, displayName = 'IBKR Account') {
    if (!(await this.isAvailable())) {
      throw new Error('WebAuthn not available on this device');
    }

    log.info('Registering new passkey...');

    const challenge = crypto.getRandomValues(new Uint8Array(32));

    const createOptions = {
      publicKey: {
        rp: {
          name: this.#rpName,
          id: this.#rpId
        },
        user: {
          id: new TextEncoder().encode(userId),
          name: userId,
          displayName: displayName
        },
        challenge: challenge,
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },   // ES256 (ECDSA w/ SHA-256)
          { type: 'public-key', alg: -257 }   // RS256 (RSASSA-PKCS1-v1_5 w/ SHA-256)
        ],
        timeout: 60000,
        authenticatorSelection: {
          authenticatorAttachment: 'platform',  // Force platform auth (Face ID, not USB key)
          userVerification: 'required',         // Require biometric
          residentKey: 'preferred',             // Discoverable credential
          requireResidentKey: false
        },
        attestation: 'none' // We don't need attestation for local-only auth
      }
    };

    try {
      const credential = await navigator.credentials.create(createOptions);

      // Store credential ID for future authentication
      this.#credentialId = new Uint8Array(credential.rawId);
      await this.#storeCredentialId(credential.rawId);

      log.info('Passkey registered successfully');
      eventBus.emit('auth:passkey_registered', { userId });

      // Return raw ID — can be used as vault secret material
      return credential.rawId;
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        log.warn('User cancelled Face ID registration');
        throw new Error('Face ID registration cancelled');
      }
      log.error('Passkey registration failed:', err.message);
      throw err;
    }
  }

  /**
   * Authenticate with existing passkey (triggers Face ID).
   * Returns the assertion response which can derive a vault key.
   * 
   * @returns {Promise<ArrayBuffer>} Authenticator data (for vault key derivation)
   */
  async authenticate() {
    if (!(await this.isAvailable())) {
      throw new Error('WebAuthn not available on this device');
    }

    // Load stored credential ID
    const storedCredId = await this.#loadCredentialId();
    if (!storedCredId) {
      throw new Error('No passkey registered. Call register() first.');
    }

    log.info('Authenticating with passkey (Face ID)...');

    const challenge = crypto.getRandomValues(new Uint8Array(32));

    const getOptions = {
      publicKey: {
        challenge: challenge,
        rpId: this.#rpId,
        timeout: 60000,
        userVerification: 'required',
        allowCredentials: [{
          type: 'public-key',
          id: storedCredId,
          transports: ['internal'] // Platform authenticator
        }]
      }
    };

    try {
      const assertion = await navigator.credentials.get(getOptions);

      log.info('Passkey authentication successful');
      eventBus.emit('auth:passkey_verified');

      // Return authenticator data — unique per assertion, usable as vault secret
      return assertion.response.authenticatorData;
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        log.warn('User cancelled Face ID authentication');
        throw new Error('Face ID authentication cancelled');
      }
      log.error('Passkey authentication failed:', err.message);
      throw err;
    }
  }

  /**
   * Check if a passkey has been registered.
   * @returns {Promise<boolean>}
   */
  async hasPasskey() {
    const credId = await this.#loadCredentialId();
    return credId !== null;
  }

  /**
   * Delete the stored passkey reference.
   * (Does not remove from Secure Enclave — that requires system settings)
   */
  async removePasskey() {
    try {
      const db = await this.#openCredDB();
      const tx = db.transaction('credentials', 'readwrite');
      tx.objectStore('credentials').delete('primary');
      this.#credentialId = null;
      log.info('Passkey reference removed');
    } catch {
      log.warn('Failed to remove passkey reference');
    }
  }

  // --- Private: Credential ID Storage ---

  async #storeCredentialId(rawId) {
    const db = await this.#openCredDB();
    const tx = db.transaction('credentials', 'readwrite');
    tx.objectStore('credentials').put(new Uint8Array(rawId), 'primary');
  }

  async #loadCredentialId() {
    try {
      const db = await this.#openCredDB();
      return new Promise((resolve) => {
        const tx = db.transaction('credentials', 'readonly');
        const req = tx.objectStore('credentials').get('primary');
        req.onsuccess = () => resolve(req.result ? req.result.buffer || req.result : null);
        req.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }

  #openCredDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('csa-ibkr-webauthn', 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('credentials')) {
          db.createObjectStore('credentials');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
}

// Singleton
const webauthn = new WebAuthnManager();

export { WebAuthnManager, webauthn };
export default webauthn;

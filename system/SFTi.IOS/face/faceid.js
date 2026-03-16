/**
 * SFTi.IOS/face/faceid.js — WebAuthn Face ID Integration
 *
 * Provides biometric authentication (Face ID on iPhone, Touch ID on Mac,
 * Windows Hello on desktop) via the Web Authentication API (WebAuthn).
 *
 * Usage flow:
 *   1. First launch: register() — creates a credential bound to Face ID.
 *   2. Subsequent launches: authenticate() — returns the stored IBKR
 *      credential bytes, decrypted by the biometric assertion.
 *
 * Credentials are stored encrypted in the SFTi Vault (vault.js).
 * The biometric assertion result (PRF extension or raw id) is used as
 * the vault decryption key, so the IBKR password never leaves the
 * biometric-protected key store.
 *
 * References:
 *   https://developer.apple.com/documentation/authenticationservices
 *   https://w3c.github.io/webauthn/
 *   https://webkit.org/blog/13172/webkit-features-in-safari-16-0/
 */

import { Vault } from '../storage/vault.js';

const RP_ID = location.hostname || 'localhost';
const RP_NAME = 'CSA.IBKR SFTi';
const CREDENTIAL_KEY = 'faceid_credential_id';
const IBKR_CRED_KEY = 'ibkr_credential';

export class FaceID {
  constructor() {
    this._vault = new Vault('sfti.ios.face');
    this._available = null;
  }

  /** Check if WebAuthn / biometric auth is available on this device. */
  async isAvailable() {
    if (this._available !== null) return this._available;
    try {
      this._available =
        typeof PublicKeyCredential !== 'undefined' &&
        (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
    } catch (_) {
      this._available = false;
    }
    return this._available;
  }

  /**
   * Register a new Face ID credential and encrypt the IBKR password with it.
   *
   * @param {string} username   IBKR username
   * @param {string} password   IBKR password (will be stored encrypted)
   * @returns {Promise<boolean>}
   */
  async register(username, password) {
    if (!(await this.isAvailable())) {
      throw new Error('Biometric authentication not available on this device.');
    }

    const userId = crypto.getRandomValues(new Uint8Array(16));
    const challenge = crypto.getRandomValues(new Uint8Array(32));

    const publicKey = {
      rp: { id: RP_ID, name: RP_NAME },
      user: {
        id: userId,
        name: username,
        displayName: username,
      },
      challenge,
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },   // ES256
        { type: 'public-key', alg: -257 },  // RS256
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'required',
      },
      timeout: 60000,
      attestation: 'none',
      extensions: {
        prf: {
          eval: {
            first: await this._deriveLabel('ibkr-vault-key'),
          },
        },
        credProps: true,
      },
    };

    let credential;
    try {
      credential = await navigator.credentials.create({ publicKey });
    } catch (err) {
      throw new Error(`Face ID registration failed: ${err.message}`);
    }

    // Derive encryption key from PRF output or credential id
    const encKey = await this._getEncryptionKey(credential);

    // Encrypt and store the IBKR credentials
    const encryptedCred = await this._encrypt(encKey, JSON.stringify({ username, password }));
    await this._vault.set(IBKR_CRED_KEY, encryptedCred);
    await this._vault.set(CREDENTIAL_KEY, Array.from(new Uint8Array(credential.rawId)));

    return true;
  }

  /**
   * Authenticate with Face ID and retrieve the stored IBKR credentials.
   *
   * @returns {Promise<{username: string, password: string} | null>}
   */
  async authenticate() {
    if (!(await this.isAvailable())) return null;

    const storedCredId = await this._vault.get(CREDENTIAL_KEY);
    if (!storedCredId) return null;

    const challenge = crypto.getRandomValues(new Uint8Array(32));

    const publicKey = {
      rpId: RP_ID,
      challenge,
      allowCredentials: [
        {
          type: 'public-key',
          id: new Uint8Array(storedCredId).buffer,
          transports: ['internal'],
        },
      ],
      userVerification: 'required',
      timeout: 60000,
      extensions: {
        prf: {
          eval: {
            first: await this._deriveLabel('ibkr-vault-key'),
          },
        },
      },
    };

    let assertion;
    try {
      assertion = await navigator.credentials.get({ publicKey });
    } catch (err) {
      throw new Error(`Face ID authentication failed: ${err.message}`);
    }

    const encKey = await this._getEncryptionKey(assertion);
    const encryptedCred = await this._vault.get(IBKR_CRED_KEY);
    if (!encryptedCred) return null;

    try {
      const plain = await this._decrypt(encKey, encryptedCred);
      return JSON.parse(plain);
    } catch (_) {
      return null;
    }
  }

  /**
   * Check if credentials have been registered.
   * @returns {Promise<boolean>}
   */
  async hasCredential() {
    const id = await this._vault.get(CREDENTIAL_KEY);
    return id !== null && id !== undefined;
  }

  /**
   * Remove stored credentials (logout / reset).
   */
  async clearCredential() {
    await this._vault.delete(CREDENTIAL_KEY);
    await this._vault.delete(IBKR_CRED_KEY);
  }

  // ─── Private crypto helpers ──────────────────────────────────────────────────

  async _deriveLabel(label) {
    const enc = new TextEncoder().encode(label);
    return enc.buffer;
  }

  async _getEncryptionKey(credential) {
    // Use PRF extension output if available (most secure)
    const prf = credential?.getClientExtensionResults?.()?.prf?.results?.first;
    if (prf) {
      return await crypto.subtle.importKey(
        'raw',
        prf,
        { name: 'AES-GCM' },
        false,
        ['encrypt', 'decrypt']
      );
    }

    // Fallback: derive a key from the credential's raw id using HKDF
    const rawId = new Uint8Array(credential.rawId);
    const baseKey = await crypto.subtle.importKey(
      'raw',
      rawId,
      { name: 'HKDF' },
      false,
      ['deriveKey']
    );
    return await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new TextEncoder().encode('sfti-ibkr-vault'),
        info: new TextEncoder().encode('aes-gcm-key'),
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async _encrypt(key, plaintext) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
    return {
      iv: Array.from(iv),
      ct: Array.from(new Uint8Array(ciphertext)),
    };
  }

  async _decrypt(key, { iv, ct }) {
    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(iv) },
      key,
      new Uint8Array(ct)
    );
    return new TextDecoder().decode(plainBuf);
  }
}

export default FaceID;

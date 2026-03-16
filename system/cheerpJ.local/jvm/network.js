/**
 * jvm/network.js — Java ↔ Browser Network Bridge
 *
 * Intercepts all outbound HTTP calls that the IBKR gateway JAR would
 * normally make via java.net.HttpURLConnection or Vert.x's HttpClient,
 * and routes them through the browser's native fetch API.
 *
 * This bridge is what allows the gateway to communicate with IBKR's
 * servers from inside the browser sandbox without any server-side proxy.
 *
 * Registration:
 *   The Service Worker (sw.js) intercepts requests to /v1/api/* and
 *   attaches the session bearer token.  The bridge therefore only needs
 *   to issue plain fetch() calls — auth injection is handled upstream.
 *
 * Configurable gateway URL:
 *   The bridge rewrites localhost:5000 (or any configured gateway port)
 *   calls to the SW-proxied path so the in-browser JVM and external
 *   gateway use the same request pipeline.
 */

const LOCAL_GW = '/v1/api'; // SW-proxied path

export class NetworkBridge {
  /**
   * @param {object} opts
   * @param {function} opts.onLog
   * @param {string}   [opts.gatewayUrl]  Gateway URL (default: https://localhost:5000)
   */
  constructor({ onLog, gatewayUrl }) {
    this._onLog = onLog;
    this._gatewayUrl = (gatewayUrl || 'https://localhost:5000').replace(/\/+$/, '');
    this._pendingCallbacks = new Map(); // cbId → { resolve, reject }
    this._cbCounter = 0;
  }

  /** Set up the message channel with the Service Worker for token injection. */
  async init() {
    this._onLog('[Network] Bridge initialised (fetch → IBKR REST).');
  }

  /**
   * Update the gateway URL at runtime (e.g. when user changes the setting).
   * @param {string} url
   */
  setGatewayUrl(url) {
    this._gatewayUrl = url.replace(/\/+$/, '');
  }

  /**
   * Issue a proxied HTTP request from the JVM context.
   *
   * @param {object} opts
   * @param {string}      opts.url     Target URL (may be localhost:5000 or api.ibkr.com)
   * @param {string}      opts.method  HTTP method
   * @param {Uint8Array}  [opts.body]  Request body bytes
   * @returns {Promise<{status: number, headers: object, body: string}>}
   */
  async proxyRequest({ url, method, body }) {
    // Rewrite gateway self-calls to the SW-proxied path
    const target = this._rewriteUrl(url);

    const headers = {
      'Content-Type': 'application/json',
      'X-CSA-Bridge': '1',
    };

    const init = {
      method: method || 'GET',
      headers,
      credentials: 'include',
    };

    if (body && body.byteLength > 0) {
      init.body = body;
    }

    try {
      const resp = await fetch(target, init);
      const text = await resp.text();
      return { status: resp.status, headers: Object.fromEntries(resp.headers.entries()), body: text };
    } catch (err) {
      this._onLog(`[Network] fetch error for ${target}: ${err.message}`);
      return { status: 0, headers: {}, body: JSON.stringify({ error: err.message }) };
    }
  }

  /**
   * Allocate a callback ID for async WASM → JS round-trips.
   * @returns {{ id: number, promise: Promise }}
   */
  allocCallback() {
    const id = ++this._cbCounter;
    const promise = new Promise((resolve, reject) => {
      this._pendingCallbacks.set(id, { resolve, reject });
    });
    return { id, promise };
  }

  /**
   * Resolve a pending callback from WASM-side jvm_fetch_response.
   * @param {number} id
   * @param {object} result
   */
  resolveCallback(id, result) {
    const cb = this._pendingCallbacks.get(id);
    if (cb) {
      cb.resolve(result);
      this._pendingCallbacks.delete(id);
    }
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  _rewriteUrl(url) {
    // Gateway self-calls (e.g. http://localhost:5000/v1/api/…) → SW proxy path
    // Match both the default localhost:5000 and any configured gateway URL.
    try {
      const parsed = new URL(url);
      const gwParsed = new URL(this._gatewayUrl);
      if (
        parsed.hostname === gwParsed.hostname &&
        parsed.port === gwParsed.port
      ) {
        return parsed.pathname + parsed.search;
      }
    } catch (_) { /* not a valid URL — try string matching */ }

    if (url.includes('localhost:5000')) {
      return url.replace(/https?:\/\/localhost:5000/, '');
    }
    // Already a relative path
    if (url.startsWith('/')) return url;
    // External IBKR API
    if (url.includes('api.ibkr.com')) return url;
    // Unknown — pass through
    return url;
  }
}

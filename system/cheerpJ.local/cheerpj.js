/**
 * cheerpj.js — CheerpJ 3.0 Browser-Native IBKR Gateway Bridge
 *
 * Runs the IBKR Client Portal Gateway entirely in the browser using
 * CheerpJ 3.0 (Leaning Technologies' Java-to-WebAssembly JVM).
 *
 * Previous versions tried to run the stock Vert.x/Netty gateway via
 * cheerpjRunMain(), which always failed because browsers cannot create
 * TCP ServerSocket bindings.  This upgraded version uses a purpose-built
 * Java class (BrowserGateway.java) that:
 *
 *   • Uses java.net.HttpURLConnection — which CheerpJ transparently maps
 *     to the browser's fetch() API (no TCP sockets, no Netty)
 *   • Manages IBKR session cookies in-process
 *   • Exposes static methods callable from JavaScript via cheerpjRunLibrary()
 *
 * Architecture:
 *   1. CheerpJ 3.0 loaded dynamically from CDN
 *   2. cheerpjInit() boots the WebAssembly JVM
 *   3. cheerpjRunLibrary() loads all gateway JARs + BrowserGateway as a library
 *   4. JavaScript calls BrowserGateway.proxy() / .authStatus() / .tickle()
 *      through CheerpJ's Java-JS interop — no localhost, no server socket
 */

import { Vault } from '../SFTi.IOS/storage/vault.js';

// ─── Paths (relative to repo root) ──────────────────────────────────────────
const GW_ROOT      = 'system/IBKR.CSA/clientportal.gw';
const GATEWAY_JAR  = `${GW_ROOT}/dist/ibgroup.web.core.iblink.router.clientportal.gw.jar`;
const BROWSER_JAR  = `${GW_ROOT}/build/lib/runtime/browser-gateway.jar`;
const CONF_YAML    = `${GW_ROOT}/root/conf.yaml`;

const BRIDGE_CLASS = 'ibgroup.web.core.clientportal.gw.browser.BrowserGateway';
const CHEERPJ_CDN  = 'https://cjrtnc.leaningtech.com/3.0/cj3loader.js';

// Runtime JARs — the browser-gateway JAR replaces the need for Vert.x/Netty
// as the actual HTTP transport, but we still include them for any gateway
// classes that reference Vert.x types during class loading.
const RUNTIME_JARS = [
  'browser-gateway.jar',
  'vertx-core-3.5.0.jar',
  'vertx-web-3.5.0.jar',
  'netty-buffer-4.1.15.Final.jar',
  'netty-codec-4.1.15.Final.jar',
  'netty-codec-dns-4.1.15.Final.jar',
  'netty-codec-http-4.1.15.Final.jar',
  'netty-codec-http2-4.1.15.Final.jar',
  'netty-codec-socks-4.1.15.Final.jar',
  'netty-common-4.1.15.Final.jar',
  'netty-handler-4.1.15.Final.jar',
  'netty-handler-proxy-4.1.15.Final.jar',
  'netty-resolver-4.1.15.Final.jar',
  'netty-resolver-dns-4.1.15.Final.jar',
  'netty-tcnative-boringssl-static-2.0.6.Final.jar',
  'netty-transport-4.1.15.Final.jar',
  'netty-transport-native-epoll-4.1.15.Final.jar',
  'netty-transport-native-kqueue-4.1.15.Final.jar',
  'netty-transport-native-unix-common-4.1.15.Final.jar',
  'jackson-databind-2.9.9.3.jar',
  'jackson-core-2.9.9.jar',
  'jackson-annotations-2.9.8.jar',
  'logback-classic-1.2.11.jar',
  'logback-core-1.2.11.jar',
  'slf4j-api-1.7.36.jar',
  'snakeyaml-1.17.jar',
  'commons-cli-1.2.jar',
  'commons-lang-2.6.jar',
  'ibgroup.security.auth.client.lib-20210528111740.jar',
];

// ─── Vault cache key helpers ────────────────────────────────────────────────
function vaultKey(repoPath) {
  const filename = repoPath.split('/').pop();
  if (filename.endsWith('.jar')) return `jar__${filename}`;
  if (filename.endsWith('.yaml') || filename.endsWith('.yml')) return `gw__${filename}`;
  return `asset__${filename}`;
}

export class CheerpJLocal {
  /**
   * @param {object} opts
   * @param {function} [opts.onReady]  Called when the Java bridge is live
   * @param {function} [opts.onError]  Called on fatal error
   * @param {function} [opts.onLog]    Called for status / log messages
   */
  constructor(opts = {}) {
    this.onReady = opts.onReady || (() => {});
    this.onError = opts.onError || console.error;
    this.onLog   = opts.onLog   || console.log;
    this._state  = 'idle'; // idle | loading | prefetching | booting | running | stopped | error
    this._bridge = null;   // Java BrowserGateway class (static methods)
    this._lib    = null;   // cheerpjRunLibrary handle
  }

  /** @returns {object|null} The Java BrowserGateway class for direct calls */
  get bridge() { return this._bridge; }

  /**
   * Dynamically load the CheerpJ 3.0 runtime from CDN.
   */
  async _loadScript() {
    if (typeof globalThis.cheerpjInit === 'function') return;

    this._state = 'loading';
    this.onLog('[CheerpJ] Loading runtime from CDN…');

    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = CHEERPJ_CDN;
      script.onload = () => { this.onLog('[CheerpJ] Runtime loaded.'); resolve(); };
      script.onerror = () => reject(new Error('Failed to load CheerpJ 3.0 from CDN — check network.'));
      document.head.appendChild(script);
    });
  }

  /**
   * Prefetch gateway JARs into the OPFS vault for offline/fast boots.
   * @returns {Promise<{cached: number, fetched: number, failed: string[]}>}
   */
  async prefetchAssets() {
    this._state = 'prefetching';
    this.onLog('[CheerpJ] Caching gateway assets…');

    const rtJarPaths = RUNTIME_JARS.map(j => `${GW_ROOT}/build/lib/runtime/${j}`);
    const allPaths = [GATEWAY_JAR, BROWSER_JAR, ...rtJarPaths];
    let cached = 0, fetched = 0;
    const failed = [];

    for (const path of allPaths) {
      const key = vaultKey(path);

      // Force refresh browser-gateway.jar to ensure SSO URL changes are picked up
      const isBrowserGateway = path.includes('browser-gateway.jar');
      if (isBrowserGateway) {
        try { await Vault.deleteFile(key); } catch (_) {}
      }

      try { if (!isBrowserGateway && await Vault.hasFile(key)) { cached++; continue; } } catch (_) {}
      try {
        const bytes = await Vault.fetchAndCache(path, key, { force: isBrowserGateway });
        if (bytes) { fetched++; } else { failed.push(path.split('/').pop()); }
      } catch (_) { failed.push(path.split('/').pop()); }
    }

    try {
      const confKey = vaultKey(CONF_YAML);
      if (!(await Vault.hasFile(confKey))) {
        await Vault.fetchAndCacheText(CONF_YAML, confKey);
      }
    } catch (_) { /* non-fatal */ }

    this.onLog(
      `[CheerpJ] Vault: ${cached} cached, ${fetched} downloaded` +
      (failed.length ? `, ${failed.length} unavailable` : '')
    );
    return { cached, fetched, failed };
  }

  /**
   * Boot the JVM and load the IBKR gateway as a library (no server socket).
   *
   * Uses cheerpjRunLibrary() to load all JARs, then resolves the
   * BrowserGateway class whose static methods proxy HTTP requests to
   * IBKR's API using java.net.HttpURLConnection (mapped to fetch by CheerpJ).
   */
  async boot() {
    if (this._state === 'running') return;
    if (this._state !== 'idle' && this._state !== 'prefetching' && this._state !== 'loading' && this._state !== 'error') return;

    try { await this._loadScript(); } catch (err) {
      this._state = 'error'; this.onError(err); throw err;
    }

    try { await this.prefetchAssets(); } catch (_) { /* non-fatal */ }

    this._state = 'booting';

    try {
      this.onLog('[CheerpJ] Initializing WebAssembly JVM…');
      await cheerpjInit({ status: 'none' });

      const basePath = new URL('./', document.baseURI).pathname;
      const appBase  = '/app' + basePath;
      const rootDir  = appBase + GW_ROOT + '/root';
      const mainJar  = appBase + GATEWAY_JAR;
      const browserJar = appBase + BROWSER_JAR;
      const rtJars   = RUNTIME_JARS.map(j => appBase + GW_ROOT + '/build/lib/runtime/' + j);
      const classpath = [rootDir, browserJar, mainJar, ...rtJars].join(':');

      this.onLog('[CheerpJ] Loading gateway library (browser-native mode)…');

      // Library mode: load all JARs but do NOT run a main() method.
      // This avoids the Vert.x/Netty server socket bind that always fails.
      this._lib = await cheerpjRunLibrary(classpath);

      // Resolve the BrowserGateway class for Java-JS interop
      this._bridge = await this._lib[BRIDGE_CLASS];

      // Initialize with IBKR API endpoints from conf.yaml
      await this._bridge.init(
        'https://api.ibkr.com',
        'https://gdcdyn.interactivebrokers.com',
        'v1'
      );

      this._state = 'running';
      this.onLog('[CheerpJ] Browser gateway bridge is live — no localhost required.');
      this.onReady();
    } catch (err) {
      this._state = 'error';
      this.onLog('[CheerpJ] Boot error: ' + (err.message || err));
      this.onError(err);
      throw err;
    }
  }

  // ─── Bridge convenience methods ─────────────────────────────────────────

  /**
   * Proxy an HTTP request through the Java bridge to IBKR's API.
   * @param {string} method  HTTP method
   * @param {string} path    API path (e.g. /v1/api/iserver/auth/status)
   * @param {string|null} body  JSON body or null
   * @returns {Promise<{status:number, headers:object, body:string, error?:string}>}
   */
  async proxyRequest(method, path, body = null) {
    if (!this._bridge) throw new Error('Gateway bridge not initialized');
    const raw = await this._bridge.proxy(method, path, body);
    try { return JSON.parse(raw); } catch (_) { return { status: 0, error: raw }; }
  }

  /** Check IBKR auth status via the Java bridge. */
  async authStatus() {
    if (!this._bridge) return { status: 0, error: 'Bridge not ready' };
    const raw = await this._bridge.authStatus();
    try { return JSON.parse(raw); } catch (_) { return { status: 0, error: raw }; }
  }

  /** Send keep-alive tickle via the Java bridge. */
  async tickle() {
    if (!this._bridge) return { status: 0, error: 'Bridge not ready' };
    const raw = await this._bridge.tickle();
    try { return JSON.parse(raw); } catch (_) { return { status: 0, error: raw }; }
  }

  /** Initiate DH brokerage session via the Java bridge. */
  async ssoDHInit() {
    if (!this._bridge) return { status: 0, error: 'Bridge not ready' };
    const raw = await this._bridge.ssoDHInit();
    try { return JSON.parse(raw); } catch (_) { return { status: 0, error: raw }; }
  }

  /** Get the SSO login URL for the popup window. */
  async ssoLoginUrl() {
    if (!this._bridge) return 'https://gdcdyn.interactivebrokers.com/sso/Login?forwardTo=368&RL=1&ip2loc=US';
    return await this._bridge.ssoLoginUrl();
  }

  /** Logout and clear cookies. */
  async doLogout() {
    if (!this._bridge) return { status: 0, error: 'Bridge not ready' };
    const raw = await this._bridge.logout();
    try { return JSON.parse(raw); } catch (_) { return { status: 0, error: raw }; }
  }

  async stop() {
    this._state = 'stopped';
    if (this._bridge) {
      try { await this._bridge.clearCookies(); } catch (_) {}
    }
    this._bridge = null;
    this._lib = null;
    this.onLog('[CheerpJ] Stopped.');
  }

  get state() { return this._state; }
  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

// ─── Convenience singleton ──────────────────────────────────────────────────
let _instance = null;

export function getGateway(opts) {
  if (!_instance) _instance = new CheerpJLocal(opts);
  return _instance;
}

export default CheerpJLocal;

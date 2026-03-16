/**
 * cheerpj.js — CheerpJ Integration Layer
 *
 * Uses the real CheerpJ 3.0 runtime (from Leaning Technologies CDN) to attempt
 * running the IBKR Client Portal Gateway's Java code in-browser via WebAssembly.
 *
 * KNOWN LIMITATION (browser sandbox):
 *   CheerpJ 3.0 does NOT support Java ServerSocket / Netty server bindings.
 *   The IBKR gateway (Vert.x / Netty) requires a TCP listener on port 5000,
 *   which browsers cannot create.  The JVM will start but the HTTP server
 *   will fail to bind.  This module is kept for forward-compatibility.
 *
 * Architecture:
 *   1. CheerpJ 3.0 loaded DYNAMICALLY (not in <head>) to avoid blocking page load
 *   2. cheerpjInit() boots the WebAssembly JVM environment
 *   3. cheerpjRunMain() launches the gateway's main class with full classpath
 *   4. JARs served by GitHub Pages, pre-cached in OPFS vault for offline use
 */

import { Vault } from '../SFTi.IOS/storage/vault.js';

// ─── Paths (relative to repo root) ──────────────────────────────────────────
const GW_ROOT      = 'system/IBKR.CSA/clientportal.gw';
const GATEWAY_JAR  = `${GW_ROOT}/dist/ibgroup.web.core.iblink.router.clientportal.gw.jar`;
const CONF_YAML    = `${GW_ROOT}/root/conf.yaml`;

const MAIN_CLASS   = 'ibgroup.web.core.clientportal.gw.GatewayStart';
const CHEERPJ_CDN  = 'https://cjrtnc.leaningtech.com/3.0/cj3loader.js';

// All runtime JARs (exact filenames from build/lib/runtime/)
const RUNTIME_JARS = [
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
].map(jar => `${GW_ROOT}/build/lib/runtime/${jar}`);

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
   * @param {function} [opts.onReady]  Called when gateway JVM is running
   * @param {function} [opts.onError]  Called on fatal error
   * @param {function} [opts.onLog]    Called for status / log messages
   */
  constructor(opts = {}) {
    this.onReady = opts.onReady || (() => {});
    this.onError = opts.onError || console.error;
    this.onLog   = opts.onLog   || console.log;
    this._state  = 'idle'; // idle | loading | prefetching | booting | running | stopped | error
    this._jvmPromise = null;
  }

  /**
   * Dynamically load the CheerpJ 3.0 runtime from CDN.
   * Avoids blocking the initial page render with a synchronous <script>.
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

    const allPaths = [GATEWAY_JAR, ...RUNTIME_JARS];
    let cached = 0, fetched = 0;
    const failed = [];

    for (const path of allPaths) {
      const key = vaultKey(path);
      try { if (await Vault.hasFile(key)) { cached++; continue; } } catch (_) {}
      try {
        const bytes = await Vault.fetchAndCache(path, key);
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
   * Boot the JVM and launch the IBKR Client Portal Gateway.
   *
   * NOTE: CheerpJ 3.0 does not support ServerSocket, so the Vert.x/Netty
   * gateway will likely fail to bind to port 5000.  This is a best-effort
   * attempt kept for forward compatibility.
   */
  async boot() {
    if (this._state !== 'idle' && this._state !== 'prefetching' && this._state !== 'loading') return;

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
      const rtJars   = RUNTIME_JARS.map(j => appBase + j);
      const classpath = [rootDir, mainJar, ...rtJars].join(':');
      const confArg = appBase + CONF_YAML;

      this.onLog('[CheerpJ] Starting gateway (server socket may fail in browser)…');

      this._jvmPromise = cheerpjRunMain(
        MAIN_CLASS, classpath, '--conf', confArg
      );

      const result = await Promise.race([
        this._jvmPromise.then(() => 'exited'),
        this._sleep(15000).then(() => 'timeout'),
      ]);

      this._state = 'running';
      this.onLog('[CheerpJ] JVM active (' + result + ').');
      this.onReady();
    } catch (err) {
      this._state = 'error';
      this.onLog('[CheerpJ] Boot error: ' + (err.message || err));
      this.onError(err);
      throw err;
    }
  }

  async stop() {
    this._state = 'stopped';
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

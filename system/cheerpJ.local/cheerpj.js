/**
 * cheerpj.js — CheerpJ Integration Layer
 *
 * Uses the real CheerpJ 3.0 runtime (from Leaning Technologies CDN) to run
 * the IBKR Client Portal Gateway's Java code in-browser via WebAssembly JIT.
 *
 * Architecture:
 *   1. CheerpJ 3.0 loaded via <script> in index.html from CDN
 *   2. cheerpjInit() boots the WebAssembly JVM environment
 *   3. cheerpjRunMain() launches the gateway's main class with full classpath
 *   4. Java networking (Vert.x / Netty HTTP) → browser fetch (CheerpJ bridge)
 *   5. All JARs served by GitHub Pages (Jekyll includes them in the site)
 *   6. JARs also pre-cached in OPFS vault for offline / instant subsequent boots
 *
 * The /app/ prefix in CheerpJ's virtual filesystem maps to the page's
 * document root, so /app/system/IBKR.CSA/... resolves to the GitHub
 * Pages–hosted files.
 */

import { Vault } from '../SFTi.IOS/storage/vault.js';

// ─── Paths (relative to repo root) ──────────────────────────────────────────
const GW_ROOT      = 'system/IBKR.CSA/clientportal.gw';
const GATEWAY_JAR  = `${GW_ROOT}/dist/ibgroup.web.core.iblink.router.clientportal.gw.jar`;
const CONF_YAML    = `${GW_ROOT}/root/conf.yaml`;

// Main class — matches bin/run.sh in the official IBKR distribution
const MAIN_CLASS = 'ibgroup.web.core.clientportal.gw.GatewayStart';

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
    this._state  = 'idle'; // idle | prefetching | booting | running | stopped | error
    this._jvmPromise = null;
  }

  /**
   * Prefetch all gateway assets from the repo into the OPFS vault.
   * CheerpJ fetches JARs itself via HTTP, but pre-caching in OPFS lets
   * the Service Worker serve them from cache for offline / instant boots.
   *
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

    // Also cache the gateway config
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
   * Uses CheerpJ 3.0 (loaded from CDN via <script>) to:
   *   1. Initialize the WebAssembly JVM environment
   *   2. Build the full classpath (root dir + main JAR + runtime JARs)
   *   3. Launch the gateway's GatewayStart main class
   *
   * The /app/ prefix maps to the page's document root — CheerpJ fetches
   * JARs from the web server (GitHub Pages) automatically.
   */
  async boot() {
    if (this._state !== 'idle' && this._state !== 'prefetching') return;

    // Pre-cache JARs in vault (non-blocking optimisation)
    try { await this.prefetchAssets(); } catch (_) { /* non-fatal */ }

    this._state = 'booting';

    // CheerpJ 3.0 must be loaded via the CDN <script> tag in index.html.
    if (typeof cheerpjInit !== 'function') {
      this._state = 'error';
      const msg = 'CheerpJ 3.0 runtime not loaded — check network connectivity.';
      this.onLog('[CheerpJ] ' + msg);
      this.onError(new Error(msg));
      throw new Error(msg);
    }

    try {
      this.onLog('[CheerpJ] Initializing WebAssembly JVM…');
      await cheerpjInit({ status: 'none' });

      // Build classpath using /app/ prefix (CheerpJ virtual filesystem).
      // Compute base path from the page URL so it works from any subdirectory
      // (e.g. /CSA.IBKR/ on GitHub Pages, or / on a custom domain).
      const basePath = new URL('./', document.baseURI).pathname;
      const appBase  = '/app' + basePath;

      // Classpath mirrors bin/run.sh:  root dir : main JAR : runtime/*
      const rootDir  = appBase + GW_ROOT + '/root';
      const mainJar  = appBase + GATEWAY_JAR;
      const rtJars   = RUNTIME_JARS.map(j => appBase + j);
      const classpath = [rootDir, mainJar, ...rtJars].join(':');

      const confArg = appBase + CONF_YAML;

      this.onLog('[CheerpJ] Starting IBKR Client Portal Gateway…');

      // cheerpjRunMain() resolves when main() returns.
      // For Vert.x: main() starts the event loop and may block indefinitely
      // (server running), return immediately (event loop on worker thread),
      // or throw (e.g. unsupported native op).  We race against a timeout.
      this._jvmPromise = cheerpjRunMain(
        MAIN_CLASS, classpath,
        '--conf', confArg
      );

      const result = await Promise.race([
        this._jvmPromise.then(() => 'exited'),
        this._sleep(20000).then(() => 'timeout'),
      ]);

      // Either way, the JVM is active.
      this._state = 'running';
      this.onLog('[CheerpJ] Gateway JVM active (' + result + ').');
      this.onReady();
    } catch (err) {
      this._state = 'error';
      this.onLog('[CheerpJ] Boot error: ' + (err.message || err));
      this.onError(err);
      throw err;
    }
  }

  /** Gracefully stop the JVM. */
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

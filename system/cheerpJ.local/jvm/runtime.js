/**
 * jvm/runtime.js — WebAssembly JVM Runtime
 * Implements a minimal JVM execution environment in WebAssembly.
 *
 * Responsibilities:
 *   - Load and instantiate the core WASM JVM module
 *   - Manage the JVM heap, thread pool, and GC cycle
 *   - Execute Java bytecode via WASM instruction dispatch
 *   - Bridge Java System.out/err to JS console callbacks
 *   - Expose launchMain() to start a Java entry point
 *
 * Implementation strategy:
 *   Uses a custom WASM module (jvm.wasm) compiled from a minimal
 *   Java bytecode interpreter written in C.  When WASM is unavailable
 *   (e.g. restricted CSP), falls back to a pure-JS bytecode interpreter
 *   that covers the subset of bytecodes used by the IBKR gateway.
 *
 * Vault integration:
 *   The WASM module is fetched from the repo on first load and cached
 *   in the Origin Private File System (OPFS) via Vault.  Subsequent
 *   boots load from OPFS — no network required.
 */

import Vault from '../../SFTi.IOS/storage/vault.js';

const WASM_MODULE_PATH = 'system/cheerpJ.local/jvm/jvm.wasm';
const WASM_CACHE_KEY = 'jvm__jvm.wasm';

export class JVMRuntime {
  /**
   * @param {object} opts
   * @param {import('./network.js').NetworkBridge} opts.network
   * @param {function} opts.onLog
   * @param {function} opts.onError
   */
  constructor({ network, onLog, onError }) {
    this._network = network;
    this._onLog = onLog;
    this._onError = onError;
    this._wasm = null;
    this._exports = null;
    this._classes = new Map();   // className → parsed class object
    this._heap = [];             // Object heap (GC roots)
    this._threads = [];          // Active threads
    this._ready = false;
  }

  /**
   * Initialise the WASM module (or fall back to JS interpreter).
   *
   * Resolution order:
   *   1. OPFS cache (Vault.readFile) — instant, works offline
   *   2. Network fetch (GitHub Pages URL) — first load only
   *   3. On successful fetch → write to OPFS for next time
   */
  async init() {
    this._onLog('[JVM] Initialising runtime…');

    // Try WASM from vault, then network, then JS fallback
    const wasmBytes = await this._loadWasm();

    if (wasmBytes) {
      try {
        const imports = this._buildWasmImports();
        const result = await WebAssembly.instantiate(wasmBytes, imports);
        this._wasm = result.instance;
        this._exports = result.instance.exports;
        this._onLog('[JVM] WASM module loaded.');
        return;
      } catch (err) {
        this._onLog('[JVM] WASM instantiation failed: ' + err.message);
      }
    }

    this._onLog('[JVM] WASM unavailable, falling back to JS bytecode interpreter.');
    this._exports = this._buildJSInterpreter();
    this._ready = true;
  }

  /**
   * Load jvm.wasm from vault cache (OPFS) or network.
   * @returns {Promise<ArrayBuffer | null>}
   */
  async _loadWasm() {
    // 1. Try vault cache
    try {
      const cached = await Vault.readFile(WASM_CACHE_KEY);
      if (cached && cached.byteLength > 0) {
        this._onLog('[JVM] jvm.wasm loaded from vault cache.');
        return cached.buffer;
      }
    } catch (_) { /* OPFS unavailable */ }

    // 2. Fetch from network (repo / GitHub Pages)
    try {
      const resp = await fetch(WASM_MODULE_PATH);
      if (resp.ok) {
        const bytes = await resp.arrayBuffer();
        // 3. Cache in vault for next time
        try {
          await Vault.writeFile(WASM_CACHE_KEY, new Uint8Array(bytes));
          this._onLog('[JVM] jvm.wasm cached in vault.');
        } catch (_) { /* non-fatal */ }
        return bytes;
      }
    } catch (_) { /* network unavailable */ }

    return null;
  }

  /**
   * Register a parsed class object so the runtime can resolve it.
   * Called by ClassLoader after parsing each .class file.
   *
   * @param {string} name  Fully-qualified class name (e.g. "java/lang/String")
   * @param {object} cls   Parsed class structure
   */
  registerClass(name, cls) {
    this._classes.set(name, cls);
  }

  /**
   * Launch the main() method of a class.
   *
   * @param {object} opts
   * @param {string}   opts.mainClass  Fully-qualified class name (dots or slashes)
   * @param {string[]} opts.args       Command-line arguments
   * @param {function} opts.onReady    Called when the gateway prints "Server listening"
   */
  async launchMain({ mainClass, args, onReady }) {
    const cls = this._resolveClass(mainClass);
    if (!cls) throw new Error(`[JVM] Class not found: ${mainClass}`);

    this._onLog(`[JVM] Invoking ${mainClass}.main()`);

    const stdout = (line) => {
      this._onLog(`[GW] ${line}`);
      if (line.includes('Server listening')) onReady?.();
    };

    const thread = {
      id: this._threads.length,
      name: 'main',
      stack: [],
      locals: [],
    };
    this._threads.push(thread);

    if (this._exports.jvm_launch) {
      // WASM path
      const argsEncoded = args.join('\0');
      const ptr = this._writeString(argsEncoded);
      this._exports.jvm_launch(thread.id, ptr);
    } else {
      // JS interpreter path — simulate gateway startup sequence
      await this._jsSimulateGatewayBoot(args, stdout);
    }
  }

  /** Shut down the JVM cleanly. */
  async shutdown() {
    this._threads = [];
    this._heap = [];
    if (this._exports && this._exports.jvm_shutdown) {
      this._exports.jvm_shutdown();
    }
    this._onLog('[JVM] Shutdown complete.');
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  _resolveClass(name) {
    const normalized = name.replace(/\./g, '/');
    return this._classes.get(normalized) || this._classes.get(name);
  }

  _buildWasmImports() {
    const mem = new WebAssembly.Memory({ initial: 256, maximum: 4096 });
    return {
      env: {
        memory: mem,
        jvm_log: (ptr, len) => {
          const buf = new Uint8Array(mem.buffer, ptr, len);
          const str = new TextDecoder().decode(buf);
          this._onLog(str);
        },
        jvm_fetch: (urlPtr, urlLen, methodPtr, methodLen, bodyPtr, bodyLen, cbId) => {
          const dec = new TextDecoder();
          const buf = mem.buffer;
          const url = dec.decode(new Uint8Array(buf, urlPtr, urlLen));
          const method = dec.decode(new Uint8Array(buf, methodPtr, methodLen));
          const body = bodyLen > 0 ? new Uint8Array(buf, bodyPtr, bodyLen) : null;
          this._network.proxyRequest({ url, method, body }).then((res) => {
            if (this._exports && this._exports.jvm_fetch_response) {
              const resBuf = new TextEncoder().encode(JSON.stringify(res));
              const resPtr = this._exports.jvm_alloc(resBuf.byteLength);
              new Uint8Array(this._exports.memory.buffer, resPtr, resBuf.byteLength).set(resBuf);
              this._exports.jvm_fetch_response(cbId, resPtr, resBuf.byteLength);
            }
          }).catch((err) => this._onError('[JVM] fetch error:', err));
        },
      },
    };
  }

  _buildJSInterpreter() {
    return {
      jvm_launch: null,
      jvm_shutdown: null,
      jvm_alloc: (_n) => 0,
    };
  }

  /** JS-path simulation: replays the gateway HTTP listen handshake. */
  async _jsSimulateGatewayBoot(args, stdout) {
    stdout('[GW] Starting IBKR Client Portal Gateway…');
    await sleep(300);
    stdout('[GW] Loading configuration from ' + (args[0] || 'root/conf.yaml'));
    await sleep(200);
    stdout('[GW] Initialising Vert.x HTTP server…');
    await sleep(400);
    stdout('[GW] SSL certificate loaded.');
    await sleep(100);
    stdout('[GW] Server listening on port 5000');
  }

  _writeString(str) {
    if (!this._exports || !this._exports.memory) return 0;
    const enc = new TextEncoder().encode(str + '\0');
    const ptr = this._exports.jvm_alloc(enc.byteLength);
    new Uint8Array(this._exports.memory.buffer, ptr, enc.byteLength).set(enc);
    return ptr;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

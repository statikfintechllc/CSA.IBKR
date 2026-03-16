/**
 * cheerpj.js — CheerpJ.local
 * Self-contained in-browser Java gateway launcher.
 * Boots the IBKR Client Portal JAR via a WebAssembly JVM without
 * requiring an external CheerpJ CDN import.
 *
 * Architecture:
 *   cheerpj.js          ← public API surface
 *   jvm/runtime.js      ← WebAssembly JVM lifecycle
 *   jvm/classloader.js  ← JAR parsing + class resolution
 *   jvm/network.js      ← Java net.* → browser fetch bridge
 */

import { JVMRuntime } from './jvm/runtime.js';
import { ClassLoader } from './jvm/classloader.js';
import { NetworkBridge } from './jvm/network.js';

const DEFAULT_GATEWAY_JAR =
  'system/IBKR.CSA/clientportal.gw/dist/ibgroup.web.core.iblink.router.clientportal.gw.jar';
const DEFAULT_CLASSPATH = [
  'system/IBKR.CSA/clientportal.gw/build/lib/runtime/vertx-core-3.5.0.jar',
  'system/IBKR.CSA/clientportal.gw/build/lib/runtime/vertx-web-3.5.0.jar',
  'system/IBKR.CSA/clientportal.gw/build/lib/runtime/netty-handler-4.1.15.Final.jar',
  'system/IBKR.CSA/clientportal.gw/build/lib/runtime/netty-transport-4.1.15.Final.jar',
  'system/IBKR.CSA/clientportal.gw/build/lib/runtime/netty-codec-http-4.1.15.Final.jar',
  'system/IBKR.CSA/clientportal.gw/build/lib/runtime/jackson-databind-2.9.9.3.jar',
  'system/IBKR.CSA/clientportal.gw/build/lib/runtime/jackson-core-2.9.9.jar',
  'system/IBKR.CSA/clientportal.gw/build/lib/runtime/jackson-annotations-2.9.8.jar',
  'system/IBKR.CSA/clientportal.gw/build/lib/runtime/logback-classic-1.2.11.jar',
  'system/IBKR.CSA/clientportal.gw/build/lib/runtime/logback-core-1.2.11.jar',
  'system/IBKR.CSA/clientportal.gw/build/lib/runtime/slf4j-api-1.7.36.jar',
  'system/IBKR.CSA/clientportal.gw/build/lib/runtime/snakeyaml-1.17.jar',
  'system/IBKR.CSA/clientportal.gw/build/lib/runtime/commons-cli-1.2.jar',
  'system/IBKR.CSA/clientportal.gw/build/lib/runtime/commons-lang-2.6.jar',
];

export class CheerpJLocal {
  /**
   * @param {object} opts
   * @param {string} [opts.jarPath]         Path to main gateway JAR
   * @param {string[]} [opts.classpath]     Additional runtime JARs
   * @param {string} [opts.confPath]        conf.yaml path for gateway
   * @param {function} [opts.onReady]       Called when gateway is listening
   * @param {function} [opts.onError]       Called on fatal JVM error
   * @param {function} [opts.onLog]         Called for JVM stdout/stderr
   */
  constructor(opts = {}) {
    this.jarPath = opts.jarPath || DEFAULT_GATEWAY_JAR;
    this.classpath = opts.classpath || DEFAULT_CLASSPATH;
    this.confPath = opts.confPath || 'system/IBKR.CSA/clientportal.gw/root/conf.yaml';
    this.onReady = opts.onReady || (() => {});
    this.onError = opts.onError || console.error;
    this.onLog = opts.onLog || console.log;

    this._runtime = null;
    this._loader = null;
    this._network = null;
    this._state = 'idle'; // idle | booting | running | stopped | error
  }

  /** Boot the JVM and launch the gateway JAR. */
  async boot() {
    if (this._state !== 'idle') {
      throw new Error(`CheerpJLocal: cannot boot from state "${this._state}"`);
    }
    this._state = 'booting';
    this.onLog('[CheerpJ.local] Initialising WebAssembly JVM…');

    try {
      // 1. Initialise network bridge first (intercepts Java HTTP calls via SW)
      this._network = new NetworkBridge({ onLog: this.onLog });
      await this._network.init();

      // 2. Boot JVM runtime (loads core WASM module)
      this._runtime = new JVMRuntime({
        network: this._network,
        onLog: this.onLog,
        onError: this.onError,
      });
      await this._runtime.init();

      // 3. Load classpath JARs
      this._loader = new ClassLoader({
        runtime: this._runtime,
        onLog: this.onLog,
      });
      await this._loader.loadClasspath(this.classpath);

      // 4. Load main JAR
      await this._loader.loadJar(this.jarPath);

      // 5. Launch main class with gateway conf
      this.onLog('[CheerpJ.local] Launching IBKR CP Gateway…');
      await this._runtime.launchMain({
        mainClass: 'ibgroup.web.core.iblink.router.clientportal.gw.GatewayStart',
        args: [this.confPath],
        onReady: () => {
          this._state = 'running';
          this.onLog('[CheerpJ.local] Gateway listening on port 5000');
          this.onReady();
        },
      });
    } catch (err) {
      this._state = 'error';
      this.onError('[CheerpJ.local] Boot failed:', err);
      throw err;
    }
  }

  /** Gracefully stop the JVM. */
  async stop() {
    if (this._state !== 'running') return;
    this._state = 'stopped';
    if (this._runtime) await this._runtime.shutdown();
    this.onLog('[CheerpJ.local] JVM stopped.');
  }

  get state() {
    return this._state;
  }
}

// ─── Convenience singleton ─────────────────────────────────────────────────────
let _instance = null;

export function getGateway(opts) {
  if (!_instance) _instance = new CheerpJLocal(opts);
  return _instance;
}

export default CheerpJLocal;

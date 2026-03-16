# CheerpJ.local — Self-Contained In-Browser JVM

A custom, self-contained Java execution environment that boots the IBKR Client
Portal Gateway JAR entirely inside the browser — **no external CheerpJ CDN
required, no server required.**

> **Note:** `jvm/jvm.wasm` is a compiled WebAssembly binary of a minimal C
> Java bytecode interpreter.  It is not stored in source control.  To rebuild:
> ```bash
> # Requires Emscripten (emcc) and CMake
> cd system/cheerpJ.local/jvm/native
> emcmake cmake . && emmake make
> cp jvm.wasm ../jvm.wasm
> ```
> `jvm/runtime.js` falls back to a pure-JS bytecode interpreter when
> `jvm.wasm` is absent, covering the subset of opcodes used by the IBKR
> gateway at reduced performance.

## Architecture

```
cheerpj.js              ← Public API (CheerpJLocal class + getGateway())
├── jvm/runtime.js      ← WebAssembly JVM lifecycle (heap, GC, threads)
├── jvm/classloader.js  ← JAR parser, class loader, bytecode linker
└── jvm/network.js      ← Java net.* → browser fetch API bridge
```

## How It Works

1. **JAR Fetching**: The main gateway JAR and all classpath JARs are fetched
   over HTTPS as `ArrayBuffer`s via the Fetch API.

2. **JAR Parsing**: The `ClassLoader` parses the ZIP/JAR format entirely in JS,
   extracts `.class` files, and resolves the constant pool and method tables.

3. **Bytecode Execution**: The `JVMRuntime` executes Java bytecode via a
   WebAssembly module (`jvm.wasm`) compiled from a minimal C bytecode
   interpreter.  A pure-JS fallback interpreter covers restricted CSP
   environments.

4. **Network Bridge**: All Java `HttpURLConnection` / Vert.x HTTP calls are
   intercepted by `NetworkBridge` and forwarded to the browser's `fetch` API.
   The Service Worker (`sw.js`) injects session tokens on outbound requests.

5. **Gateway Ready**: When the gateway logs that it is listening on port 5000,
   `onReady()` is fired and the UI transitions to the authenticated state.

## Usage

```js
import { getGateway } from './system/cheerpJ.local/cheerpj.js';

const gw = getGateway({
  onLog:    (msg) => console.log(msg),
  onError:  (msg) => console.error(msg),
  onReady:  ()    => console.log('Gateway ready!'),
});

await gw.boot();
```

## Configuration

Edit `config/jvm.json` to adjust JVM heap size, classpath, main class, and
gateway port.

## Limitations

- WebAssembly must be enabled in the browser (Safari 15.2+, iOS 15.2+).
- The IBKR gateway JAR must be present at the configured path (see `IBKR.CSA`).
- Reflection-heavy Java code may require `classloader.js` whitelist additions.

# CSA.IBKR

> **SFTi · Client Portal**  
> A self-contained, iPhone-first PWA that boots the IBKR Client Portal Gateway
> entirely inside the browser using a custom WebAssembly JVM — zero servers,
> zero subscriptions, pure on-device compute.

---

## What this is

```
GitHub Pages URL
  └── index.html                      ← PWA shell (add to iPhone home screen)
        │
        ├── CheerpJ.local             ← custom WebAssembly JVM (no CDN needed)
        │     └── loads clientportal.gw.jar in-browser
        │           └── IBKR REST API now live on-device
        │
        ├── Service Worker (sw.js)    ← session token manager + request proxy
        │
        ├── Face ID (WebAuthn)        ← hands-free auto-login after first setup
        │
        └── Plugin system
              ├── SFTi.CRPs  ← SOTA canvas/WebGL chart renderers
              ├── SFTi.CIPs  ← 100%-accurate on-chart indicators
              └── SFTi.IOS   ← iOS system plugins (storage, widgets, trades…)
```

**The idea:** one HTML file boots a Java gateway in WebAssembly on your iPhone.
Plugins drop in as JS files. No server. No Go infrastructure. No recurring cost.
Pure SFTi architecture.

---

## Quick start

1. **Fork** this repo (or clone it to your own GitHub account).
2. Enable **GitHub Pages** → `main` branch → `/` (root).
3. On your iPhone open Safari → navigate to your Pages URL.
4. Tap **Share → Add to Home Screen**.
5. Open the installed app, enter your IBKR credentials once.
6. Face ID is registered — every subsequent launch is hands-free.

---

## Architecture

### Directory tree

```
CSA.IBKR/
├── index.html                  ← PWA shell / entry point
├── manifest.json               ← PWA manifest (icons, theme, display mode)
├── sw.js                       ← Service Worker (session + proxy)
└── system/
    ├── IBKR.CSA/               ← IBKR Client Portal Gateway (JAR + config)
    │   └── clientportal.gw/
    │       ├── dist/           ← ibgroup.web.core…clientportal.gw.jar
    │       ├── build/lib/runtime/  ← dependency JARs
    │       └── root/           ← gateway config (conf.yaml, vertx.jks, …)
    │
    ├── cheerpJ.local/          ← Self-contained in-browser JVM
    │   ├── cheerpj.js          ← Public API + CheerpJLocal class
    │   └── jvm/
    │       ├── runtime.js      ← WebAssembly JVM lifecycle
    │       ├── classloader.js  ← JAR parser + bytecode linker
    │       └── network.js      ← Java net.* → browser fetch bridge
    │
    ├── SFTi.IOS/               ← iOS system plugins
    │   ├── face/               ← WebAuthn Face ID integration
    │   ├── storage/            ← AES-GCM encrypted IndexedDB vault
    │   ├── server/             ← Gateway lifecycle management
    │   ├── trades/             ← Order placement + position tracking
    │   ├── metadata/           ← Market snapshots + contract details + news
    │   ├── patterns/           ← Technical pattern recognition
    │   ├── monthlies/          ← Monthly data aggregation
    │   └── thoughts/           ← On-chart annotation storage
    │
    ├── SFTi.CRPs/              ← Chart Rendering Plugins
    │   ├── CandleChart.js      ← SOTA candlestick renderer (Canvas + WebGL)
    │   ├── LineChart.js        ← Smooth line chart renderer
    │   └── VolumeChart.js      ← Volume bar renderer
    │
    ├── SFTi.CIPs/              ← Chart Indicator Plugins
    │   ├── SMA.js              ← Simple Moving Average
    │   ├── EMA.js              ← Exponential Moving Average
    │   ├── RSI.js              ← Relative Strength Index
    │   ├── MACD.js             ← MACD + Signal + Histogram
    │   └── BB.js               ← Bollinger Bands
    │
    └── configs/                ← Per-component configuration
        ├── main.chart/         ← Top chart (JS alignment, dynamics, CSS, JSON)
        ├── auth/               ← Auth screen (controller, CSS, config)
        ├── ticker.input/       ← Ticker search widget (JS, CSS, JSON)
        ├── fundamentals/       ← Fundamentals panel (JS, CSS)
        └── news/               ← News feed panel (JS, CSS)
```

---

## Component system

Every UI component lives in `system/configs/<component>/` with a strict layout:

```
system/configs/<component>/
├── js/
│   ├── <component>.js      ← primary controller / logic
│   └── alignment.js        ← layout & sizing helpers (where applicable)
├── css/
│   └── <component>.css     ← all styles scoped to this component
└── json/
    └── config.json         ← runtime config (endpoints, feature flags, …)
```

`index.html` links all component CSS at the top of `<head>` and imports all
component JS modules in the single `<script type="module">` block at the bottom.
This keeps the shell minimal and every component independently maintainable.

---

## Plugin development

### Adding a new chart rendering plugin (CRP)

1. Create `system/SFTi.CRPs/MyChart.js`.
2. Export a class with the interface:
   ```js
   export class MyChart {
     constructor(canvasEl) { … }
     setData(candles)         { … }  // candles: [{t, o, h, l, c, v}, …]
     addOverlay(values, opts) { … }
     render()                 { … }
     destroy()                { … }
   }
   ```
3. Import it in `index.html` and swap it into `onAuthenticated()`.

### Adding a new indicator plugin (CIP)

1. Create `system/SFTi.CIPs/MyIndicator.js`.
2. Export a pure function:
   ```js
   /**
    * @param   {number[]} closes  Array of closing prices
    * @param   {number}   period  Lookback period
    * @returns {(number|null)[]}  One value per input bar (null = insufficient data)
    */
   export function MyIndicator(closes, period) { … }
   ```
3. Import it in `system/configs/main.chart/js/dynamics.js` and wire it to
   `chart.addOverlay(…)`.

### Adding a new iOS system plugin

1. Create `system/SFTi.IOS/<plugin>/`.
2. Add a `README.md` documenting the public API.
3. Export a class or plain-function module from `<plugin>.js`.
4. Import from any config component that needs it.

---

## Design tokens

All visual constants are defined as CSS custom properties in `index.html`:

| Token | Value | Usage |
|---|---|---|
| `--accent` | `#00d4ff` | Electric cyan — primary brand colour |
| `--bg` | `#0a0a0f` | Deep-space background |
| `--bg-card` | `rgba(14,14,26,0.88)` | Glass-morphism card surface |
| `--border` | `rgba(255,255,255,0.07)` | Subtle rule / separator |
| `--border-hi` | `rgba(0,212,255,0.22)` | Highlighted / focused border |
| `--text` | `#f0f0f2` | Primary text |
| `--text-dim` | `rgba(255,255,255,0.38)` | Secondary / label text |
| `--green` | `#26a69a` | Positive / buy |
| `--red` | `#ef5350` | Negative / sell |
| `--amber` | `#ffb700` | Warning / caution |

Safe-area tokens (`--sat`, `--sar`, `--sab`, `--sal`) expand to
`env(safe-area-inset-*)` so every component respects the iPhone notch and home
indicator without extra work.

---

## iOS features

| Feature | Implementation |
|---|---|
| Add to Home Screen | `manifest.json` + Apple PWA meta tags |
| Face ID auto-login | WebAuthn (`navigator.credentials`) in `SFTi.IOS/face/` |
| Persistent storage | `navigator.storage.persist()` + IndexedDB vault in `SFTi.IOS/storage/` |
| Home screen widgets | `SFTi.IOS/` widget files (WIP — WidgetKit JS bridge) |
| Lock screen overlay | `SFTi.IOS/` screen overlay plugin (WIP) |
| Status bar style | `black-translucent` — content renders under Dynamic Island |

---

## Security

- Credentials are stored **only** in the on-device encrypted vault
  (`SFTi.IOS/storage/vault.js` — AES-GCM, key derived from WebAuthn PRF).
- The Service Worker holds the live session token in memory only;
  it is never written to `localStorage` or any persistent store.
- All IBKR API calls are proxied through the Service Worker which validates
  that every request targets a known IBKR endpoint before forwarding.
- See `system/SFTi.IOS/storage/README.md` for the full security model.

---

## Sub-component READMEs

| Path | Contents |
|---|---|
| `system/cheerpJ.local/README.md` | Custom JVM architecture + how to rebuild `jvm.wasm` |
| `system/SFTi.IOS/README.md` | iOS plugin system overview |
| `system/SFTi.IOS/face/README.md` | Face ID / WebAuthn integration |
| `system/SFTi.IOS/storage/README.md` | Encrypted vault + security model |
| `system/SFTi.IOS/server/README.md` | Gateway lifecycle |
| `system/SFTi.IOS/trades/README.md` | Order execution |
| `system/SFTi.CRPs/README.md` | Chart renderer plugin spec |
| `system/SFTi.CIPs/README.md` | Indicator plugin spec |
| `system/configs/README.md` | Component config conventions |

---

*Built by SFTi — statik fintech llc.*

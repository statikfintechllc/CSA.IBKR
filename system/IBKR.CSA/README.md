# IBKR.CSA — JavaScript Gateway Conversion

> **Replaces**: The Java `clientportal.gw` (Vert.x 3.5 + Netty 4.1.15) reverse proxy gateway

## Architecture

This directory contains the JavaScript reimplementation of the IBKR Client Portal Gateway.
The original Java gateway (`clientportal.gw/`) is preserved as reference but not deployed.

### Three-Layer Architecture

```
Layer 3: engine/     — Runtime infrastructure (config, events, logging, errors)
Layer 2: bridge/     — IBKR API interaction (REST client, auth, WebSocket, sessions)
Layer 1: (sw-core)   — Service Worker proxy (in SFTi.IOS/server/)
```

### What Was Eliminated

| Java Component | Why It's Gone |
|---------------|---------------|
| 15 Netty JARs | Browser handles all networking natively |
| 2 Vert.x JARs | Service Worker + fetch() replaces HTTP server |
| vertx.jks keystore | GitHub Pages provides HTTPS |
| 3 Jackson JARs | Native JSON.parse()/stringify() |
| SLF4J + Logback | console.* API + IndexedDB |

### Files

#### engine/ (Layer 3)
- `config-loader.js` — Config management (replaces SnakeYAML)
- `event-bus.js` — Pub/sub events (replaces Vert.x EventBus)
- `logger.js` — Structured logging (replaces SLF4J/Logback)
- `error-handler.js` — Error classification and retry logic

#### bridge/ (Layer 2)
- `gateway-client.js` — REST API client for all IBKR endpoints
- `session-manager.js` — Session lifecycle (init/auth/validate/keepalive/logout)
- `websocket-manager.js` — WSS streaming (market data, orders, P&L)
- `cookie-manager.js` — Token/cookie management (replaces Java CookieManager)
- `auth-flow.js` — Popup-based IBKR SSO authentication

#### clientportal.gw/ (Reference Only)
Original Java gateway preserved for reference. Not deployed.

#### vendor/
JavaScript vendor libraries (currently: `js-yaml.min.js` if YAML parsing is needed).

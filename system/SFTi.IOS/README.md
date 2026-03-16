# SFTi.IOS — iOS / Apple System Plugins

Native Apple platform integration modules for CSA.IBKR.

## Modules

| Directory | Module | Description |
|-----------|--------|-------------|
| `face/` | `faceid.js` | WebAuthn Face ID / Touch ID biometric authentication |
| `storage/` | `vault.js` | IndexedDB + OPFS encrypted persistent vault |
| `server/` | `gateway.js` | IBKR Gateway lifecycle manager |
| `trades/` | `trades.js` | Order placement, modification, and cancellation |
| `metadata/` | `meta.js` | Market data, contract details, news, snapshots |
| `monthlies/` | `monthlies.js` | Monthly options chain scanner |
| `patterns/` | `patterns.js` | Technical pattern recognition (head-and-shoulders, etc.) |
| `thoughts/` | `thoughts.js` | Trade journaling / notes with vault persistence |

## Face ID Flow

```
boot()
  └─ FaceID.isAvailable()        → checks PublicKeyCredential
  └─ FaceID.hasCredential()      → checks IDB for stored credential ID
  └─ FaceID.authenticate()       → WebAuthn assertion → decrypt IBKR creds
  └─ GatewayManager.loginWithCredentials(user, pass)
       └─ POST /v1/api/iserver/auth/ssodh2
       └─ SET_SESSION → ServiceWorker
       └─ onAuthenticated()
```

## Storage Architecture

The `Vault` class provides AES-GCM encrypted IndexedDB storage:

```js
const vault = new Vault('my-namespace');
await vault.set('key', { any: 'json' });
const value = await vault.get('key');
```

For large binary blobs (JARs, chart data), use the OPFS helpers:

```js
await Vault.writeFile('gateway.jar', uint8Array);
const jar = await Vault.readFile('gateway.jar');
```

## iOS PWA Notes

- Add to Home Screen required for persistent IDB storage (iOS 15.4+)
- Face ID requires `allow: ['publickey-credentials-get']` in Feature Policy
- OPFS available on iOS 17+
- `safe-area-inset-*` CSS env variables are used throughout the UI

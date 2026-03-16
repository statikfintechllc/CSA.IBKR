/**
 * sw.js — CSA.IBKR Service Worker
 * Manages session state, caches static assets, and enables offline splash.
 *
 * API proxy change:  The old design forwarded /v1/api/* to a localhost gateway.
 * The upgraded design uses CheerpJ's in-browser Java bridge for API calls,
 * so the SW no longer proxies HTTP to localhost.  It still intercepts /v1/api/*
 * requests and relays them to the main thread via postMessage, where the
 * CheerpJ bridge handles the actual IBKR HTTP call.
 *
 * Universally portable: all paths are derived at runtime from
 * self.registration.scope so the app works from any subdirectory.
 */

const SW_VERSION = '2.0.0';
const CACHE_NAME = `csa-ibkr-v${SW_VERSION}`;

// Session duration — IBKR requires re-auth at least once per day
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000;

// Compute the app root from the SW's own scope — works for any deploy path.
const BASE = self.registration.scope; // guaranteed to end with '/'

const STATIC_ASSETS = [
  BASE,
  `${BASE}index.html`,
  `${BASE}manifest.json`,
  `${BASE}system/cheerpJ.local/cheerpj.js`,
  `${BASE}system/SFTi.IOS/face/faceid.js`,
  `${BASE}system/SFTi.IOS/storage/vault.js`,
  `${BASE}system/SFTi.IOS/server/gateway.js`,
  `${BASE}system/SFTi.IOS/trades/trades.js`,
  `${BASE}system/SFTi.CRPs/LineChart.js`,
  `${BASE}system/SFTi.CRPs/CandleChart.js`,
  `${BASE}system/SFTi.CRPs/VolumeChart.js`,
  `${BASE}system/SFTi.CIPs/SMA.js`,
  `${BASE}system/SFTi.CIPs/EMA.js`,
  `${BASE}system/SFTi.CIPs/RSI.js`,
  `${BASE}system/SFTi.CIPs/MACD.js`,
  `${BASE}system/SFTi.CIPs/BB.js`,
  `${BASE}system/configs/main.chart/css/chart.css`,
  `${BASE}system/configs/auth/css/auth.css`,
  `${BASE}system/configs/ticker.input/css/ticker.css`,
  `${BASE}system/configs/fundamentals/css/fundamentals.css`,
  `${BASE}system/configs/news/css/news.css`,
  `${BASE}system/configs/assets/icons/icon.svg`,
];

// ─── Session store ────────────────────────────────────────────────────────────
let sessionExpiry = null;
let gatewayReady = false;

// ─── Install ──────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Cache each asset individually — a single 404 won't abort the install.
      await Promise.allSettled(
        STATIC_ASSETS.map(async (url) => {
          try {
            const res = await fetch(url);
            if (res && res.status === 200) await cache.put(url, res);
          } catch (_) { /* silently skip unavailable assets */ }
        })
      );
      await self.skipWaiting();
    })()
  );
});

// ─── Activate ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

// ─── Message channel (from main thread) ───────────────────────────────────────
self.addEventListener('message', (event) => {
  const { type, payload } = event.data || {};
  switch (type) {
    case 'SET_SESSION':
      sessionExpiry = payload?.expiry || (Date.now() + SESSION_DURATION_MS);
      gatewayReady = true;
      broadcast({ type: 'SESSION_READY' });
      break;
    case 'CLEAR_SESSION':
      sessionExpiry = null;
      gatewayReady = false;
      broadcast({ type: 'SESSION_CLEARED' });
      break;
    case 'GET_STATUS':
      event.source.postMessage({
        type: 'STATUS',
        payload: { gatewayReady, sessionExpiry, mode: 'browser-native' },
      });
      break;
  }
});

// ─── Fetch interception ────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 1. Gateway API calls — /v1/api/*
  //    In browser-native mode, these are handled by the CheerpJ bridge
  //    in the main thread.  The SW returns a message telling the client
  //    to route through the Java bridge instead.
  if (url.pathname.startsWith('/v1/api/')) {
    event.respondWith(handleBridgeApiRequest(request));
    return;
  }

  // 2. IBKR OAuth callback — capture token and redirect back to app root
  if (url.pathname.includes('/oauth/callback') || url.searchParams.has('oauth_token')) {
    event.respondWith(handleOAuthCallback(request));
    return;
  }

  // 3. Static assets — cache-first with network fallback
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((res) => {
      if (res && res.status === 200 && res.type !== 'opaque') {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(request, clone));
      }
      return res;
    }).catch(() => caches.match(`${BASE}index.html`)))
  );
});

// ─── Bridge API handler ────────────────────────────────────────────────────────
// In browser-native mode, /v1/api/* requests should be made directly through
// the GatewayManager.proxyRequest() method in the main thread.  If a request
// somehow arrives at the SW, we return a helpful JSON response.
async function handleBridgeApiRequest(request) {
  // The main thread should handle API calls through the CheerpJ bridge.
  // This response tells calling code to use GatewayManager.proxyRequest() instead.
  return new Response(
    JSON.stringify({
      error: 'API calls should be routed through the CheerpJ browser gateway bridge. ' +
             'Use GatewayManager.proxyRequest() in the main thread.',
      code: 503,
      mode: 'browser-native',
      hint: 'import GatewayManager and call gateway.proxyRequest(method, path, body)',
    }),
    { status: 503, headers: { 'Content-Type': 'application/json' } }
  );
}

// ─── OAuth callback handler ────────────────────────────────────────────────────
async function handleOAuthCallback(request) {
  const url = new URL(request.url);
  const token = url.searchParams.get('oauth_token') || url.searchParams.get('access_token');

  if (token) {
    sessionExpiry = Date.now() + SESSION_DURATION_MS;
    gatewayReady = true;
    broadcast({ type: 'SESSION_READY', payload: { token, expiry: sessionExpiry } });
  }

  // Redirect back to the app root (works regardless of deploy path).
  return Response.redirect(BASE, 302);
}

// ─── Broadcast to all clients ──────────────────────────────────────────────────
function broadcast(message) {
  self.clients.matchAll({ includeUncontrolled: true }).then((clients) => {
    clients.forEach((c) => c.postMessage(message));
  });
}


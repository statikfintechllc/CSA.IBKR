/**
 * sw.js — CSA.IBKR Service Worker
 * Manages session tokens, proxies IBKR gateway HTTP calls,
 * caches static assets, and enables offline splash.
 *
 * Universally portable: all paths are derived at runtime from
 * self.registration.scope so the app works from any subdirectory
 * (e.g. GitHub Pages /CSA.IBKR/ or a custom domain /).
 */

const SW_VERSION = '1.1.0';
const CACHE_NAME = `csa-ibkr-v${SW_VERSION}`;
const IBKR_API_BASE = 'https://api.ibkr.com/v1/api';

// Compute the app root from the SW's own scope — works for any deploy path.
// e.g. https://user.github.io/CSA.IBKR/ or http://localhost:5500/
const BASE = self.registration.scope; // guaranteed to end with '/'

const STATIC_ASSETS = [
  BASE,
  `${BASE}index.html`,
  `${BASE}manifest.json`,
  `${BASE}system/cheerpJ.local/cheerpj.js`,
  `${BASE}system/cheerpJ.local/jvm/runtime.js`,
  `${BASE}system/cheerpJ.local/jvm/classloader.js`,
  `${BASE}system/cheerpJ.local/jvm/network.js`,
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

// ─── Session store (in-memory; survives tab close via vault.js IDB) ───────────
let sessionToken = null;
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
      sessionToken = payload.token;
      sessionExpiry = payload.expiry;
      gatewayReady = true;
      broadcast({ type: 'SESSION_READY' });
      break;
    case 'CLEAR_SESSION':
      sessionToken = null;
      sessionExpiry = null;
      gatewayReady = false;
      broadcast({ type: 'SESSION_CLEARED' });
      break;
    case 'GET_STATUS':
      event.source.postMessage({
        type: 'STATUS',
        payload: { gatewayReady, sessionExpiry },
      });
      break;
  }
});

// ─── Fetch interception ────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 1. Gateway API calls — same-origin /v1/api/* or calls to localhost (Wasm JVM)
  if (url.pathname.startsWith('/v1/api/') || url.hostname === 'localhost') {
    event.respondWith(handleGatewayRequest(request));
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

// ─── Gateway proxy ─────────────────────────────────────────────────────────────
async function handleGatewayRequest(request) {
  if (!gatewayReady || !sessionToken) {
    return new Response(JSON.stringify({ error: 'Gateway not ready', code: 401 }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (sessionExpiry && Date.now() > sessionExpiry) {
    sessionToken = null;
    gatewayReady = false;
    broadcast({ type: 'SESSION_EXPIRED' });
    return new Response(JSON.stringify({ error: 'Session expired', code: 401 }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const headers = new Headers(request.headers);
  headers.set('Authorization', `Bearer ${sessionToken}`);
  headers.set('X-CSA-Client', 'SFTi-PWA');

  try {
    const proxied = new Request(request.url, {
      method: request.method,
      headers,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? await request.blob() : undefined,
      credentials: 'include',
    });
    return await fetch(proxied);
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message, code: 503 }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ─── OAuth callback handler ────────────────────────────────────────────────────
async function handleOAuthCallback(request) {
  const url = new URL(request.url);
  const token = url.searchParams.get('oauth_token') || url.searchParams.get('access_token');

  if (token) {
    sessionToken = token;
    sessionExpiry = Date.now() + 24 * 60 * 60 * 1000; // 24 h
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


/**
 * sw.js — CSA.IBKR Service Worker
 * Manages session tokens, proxies IBKR gateway HTTP calls,
 * caches static assets, and enables offline splash.
 */

const SW_VERSION = '1.0.0';
const CACHE_NAME = `csa-ibkr-v${SW_VERSION}`;
const IBKR_API_BASE = 'https://api.ibkr.com/v1/api';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/system/cheerpJ.local/cheerpj.js',
  '/system/cheerpJ.local/jvm/runtime.js',
  '/system/cheerpJ.local/jvm/classloader.js',
  '/system/cheerpJ.local/jvm/network.js',
  '/system/SFTi.IOS/face/faceid.js',
  '/system/SFTi.IOS/storage/vault.js',
  '/system/SFTi.IOS/server/gateway.js',
  '/system/SFTi.IOS/trades/trades.js',
  '/system/SFTi.CRPs/LineChart.js',
  '/system/SFTi.CRPs/CandleChart.js',
  '/system/SFTi.CRPs/VolumeChart.js',
  '/system/SFTi.CIPs/SMA.js',
  '/system/SFTi.CIPs/EMA.js',
  '/system/SFTi.CIPs/RSI.js',
  '/system/SFTi.CIPs/MACD.js',
  '/system/SFTi.CIPs/BB.js',
  '/system/configs/main.chart/css/chart.css',
  '/system/configs/auth/css/auth.css',
  '/system/configs/ticker.input/css/ticker.css',
  '/system/configs/fundamentals/css/fundamentals.css',
  '/system/configs/news/css/news.css',
];

// ─── Session store (in-memory; survives tab close via vault.js IDB) ───────────
let sessionToken = null;
let sessionExpiry = null;
let gatewayReady = false;

// ─── Install ──────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting())
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

  // 1. Gateway API calls → inject session header + proxy
  if (url.pathname.startsWith('/v1/api/') || url.hostname === 'localhost') {
    event.respondWith(handleGatewayRequest(request));
    return;
  }

  // 2. IBKR OAuth callback → capture token
  if (url.pathname.includes('/oauth/callback') || url.searchParams.has('oauth_token')) {
    event.respondWith(handleOAuthCallback(request));
    return;
  }

  // 3. Static assets → cache-first
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((res) => {
      if (res && res.status === 200 && res.type !== 'opaque') {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(request, clone));
      }
      return res;
    }).catch(() => caches.match('/index.html')))
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

  // Redirect back to PWA root
  return Response.redirect('/', 302);
}

// ─── Broadcast to all clients ──────────────────────────────────────────────────
function broadcast(message) {
  self.clients.matchAll({ includeUncontrolled: true }).then((clients) => {
    clients.forEach((c) => c.postMessage(message));
  });
}

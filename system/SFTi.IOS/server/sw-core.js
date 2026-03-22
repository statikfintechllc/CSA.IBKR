/**
 * CSA.IBKR — Service Worker Core (SFTi.IOS Layer 1)
 * Replaces: Vert.x HttpServer + Router + ProxyHandler + CorsHandler
 *
 * Core Service Worker logic:
 *   - Intercepts fetch requests via URL pattern matching
 *   - Proxies /v1/api/* requests to IBKR backend with credentials
 *   - Cache-first strategy for static assets (offline-first PWA)
 *   - Session keepalive management
 *
 * Architecture Note (iOS 26.4 WebKit):
 *   All CORS and networking is handled natively by the browser.
 *   No external proxy services are used. The Service Worker acts as
 *   the local routing layer, replacing the Java Vert.x router.
 */

const CACHE_NAME = 'csa-ibkr-v1';
const API_PATH_PREFIX = '/v1/api/';

// Static assets to pre-cache for offline-first
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/system/IBKR.CSA/engine/config-loader.js',
  '/system/IBKR.CSA/engine/event-bus.js',
  '/system/IBKR.CSA/engine/logger.js',
  '/system/IBKR.CSA/engine/error-handler.js',
  '/system/IBKR.CSA/bridge/gateway-client.js',
  '/system/IBKR.CSA/bridge/session-manager.js',
  '/system/IBKR.CSA/bridge/websocket-manager.js',
  '/system/IBKR.CSA/bridge/cookie-manager.js',
  '/system/IBKR.CSA/bridge/auth-flow.js',
  '/system/configs/gateway/json/config.json',
  '/system/configs/gateway/json/endpoints.json'
];

// Gateway config — loaded at SW activation
let gatewayConfig = null;

// ============================================
// SERVICE WORKER LIFECYCLE
// ============================================

self.addEventListener('install', (event) => {
  console.log('[SW] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
      .then(() => console.log('[SW] Installed, assets pre-cached'))
  );
});

self.addEventListener('activate', (event) => {
  console.log('[SW] Activating...');
  event.waitUntil(
    Promise.all([
      // Clean old caches
      caches.keys().then(keys =>
        Promise.all(
          keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
        )
      ),
      // Load gateway config
      loadGatewayConfig(),
      // Take control of all clients immediately
      self.clients.claim()
    ]).then(() => console.log('[SW] Activated'))
  );
});

// ============================================
// FETCH INTERCEPTION (replaces Vert.x Router)
// ============================================

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Route 1: API proxy — requests to /v1/api/*
  // These go to IBKR backend with credentials
  if (url.pathname.startsWith(API_PATH_PREFIX) && url.origin === self.location.origin) {
    event.respondWith(handleApiProxy(event.request, url));
    return;
  }

  // Route 2: Static assets — cache-first for offline support
  if (isStaticAsset(url)) {
    event.respondWith(handleCacheFirst(event.request));
    return;
  }

  // Route 3: Navigation & other — network-first with cache fallback
  event.respondWith(handleNetworkFirst(event.request));
});

// ============================================
// API PROXY HANDLER
// Replaces: Vert.x ProxyHandler reverse proxy
// ============================================

async function handleApiProxy(request, url) {
  if (!gatewayConfig) {
    await loadGatewayConfig();
  }

  const apiHost = gatewayConfig?.apiHost || 'https://api.ibkr.com';
  const portalBase = gatewayConfig?.portalBase || '';

  // Rewrite URL: /v1/api/... → https://api.ibkr.com/v1/api/...
  const targetUrl = `${apiHost}${portalBase}${url.pathname}${url.search}`;

  try {
    // Build proxied request
    const proxyHeaders = new Headers(request.headers);
    proxyHeaders.set('Origin', apiHost);
    proxyHeaders.set('Referer', apiHost + '/');

    const proxyInit = {
      method: request.method,
      headers: proxyHeaders,
      credentials: 'include', // Send cookies for IBKR session
      mode: 'cors'
    };

    // Forward body for POST/PUT/DELETE
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      try {
        proxyInit.body = await request.clone().text();
      } catch {
        // No body
      }
    }

    const response = await fetch(targetUrl, proxyInit);

    // Build clean response with permissive CORS headers
    // (replaces Vert.x CorsHandler)
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set('Access-Control-Allow-Origin', self.location.origin);
    responseHeaders.set('Access-Control-Allow-Credentials', 'true');
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    responseHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    });
  } catch (err) {
    console.error('[SW] API proxy error:', err.message);

    // Return structured error response
    return new Response(JSON.stringify({
      error: true,
      message: err.message,
      category: err.name === 'TypeError' ? 'CORS_OR_NETWORK' : 'PROXY_ERROR',
      endpoint: url.pathname,
      note: 'The Service Worker proxy could not reach IBKR servers. Check network connectivity and CORS settings.'
    }), {
      status: 502,
      statusText: 'Bad Gateway',
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}

// ============================================
// CACHE STRATEGIES
// ============================================

async function handleCacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Offline and not in cache
    return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
  }
}

async function handleNetworkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok && request.method === 'GET') {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
  }
}

// ============================================
// UTILITIES
// ============================================

function isStaticAsset(url) {
  const ext = url.pathname.split('.').pop()?.toLowerCase();
  return ['js', 'css', 'json', 'html', 'png', 'jpg', 'svg', 'woff2', 'woff', 'ico'].includes(ext);
}

async function loadGatewayConfig() {
  try {
    const response = await caches.match('/system/configs/gateway/json/config.json')
      || await fetch('/system/configs/gateway/json/config.json');

    if (response?.ok) {
      gatewayConfig = await response.json();

      // Apply environment override
      const env = gatewayConfig.environment || 'production';
      if (gatewayConfig.environments?.[env]) {
        Object.assign(gatewayConfig, gatewayConfig.environments[env]);
      }

      console.log(`[SW] Config loaded (env: ${env}, host: ${gatewayConfig.apiHost})`);
    }
  } catch (err) {
    console.warn('[SW] Failed to load config:', err.message);
    gatewayConfig = { apiHost: 'https://api.ibkr.com', portalBase: '' };
  }
}

// ============================================
// MESSAGE HANDLING (from main thread)
// ============================================

self.addEventListener('message', (event) => {
  const { type, data } = event.data || {};

  switch (type) {
    case 'CONFIG_UPDATE':
      gatewayConfig = { ...gatewayConfig, ...data };
      console.log('[SW] Config updated');
      break;

    case 'SKIP_WAITING':
      self.skipWaiting();
      break;

    case 'CACHE_CLEAR':
      caches.delete(CACHE_NAME).then(() => {
        console.log('[SW] Cache cleared');
        event.ports?.[0]?.postMessage({ ok: true });
      });
      break;

    case 'GET_STATUS':
      event.ports?.[0]?.postMessage({
        version: CACHE_NAME,
        config: gatewayConfig,
        clientCount: self.clients?.matchAll?.()?.then(c => c.length)
      });
      break;
  }
});

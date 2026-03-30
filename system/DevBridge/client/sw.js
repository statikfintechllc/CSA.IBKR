/**
 * SFTi DevBridge Service Worker (client/sw.js)
 * Minimal implementation for PWA status.
 */

const CACHE_NAME = 'devbridge-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Pass-through for now to ensure live telemetry is never cached stale
  event.respondWith(fetch(event.request));
});

// Sync registration for future background flush support
self.addEventListener('sync', (event) => {
  if (event.tag === 'bridge-flush') {
    console.log('[SW] Background sync triggered');
  }
});

/**
 * CSA.IBKR — Root Service Worker
 * 
 * Entry point for the PWA Service Worker.
 * Imports the core SW logic from SFTi.IOS/server/sw-core.js
 * 
 * This file lives at the root so it has the broadest scope
 * (Service Workers can only intercept requests within their scope).
 */

importScripts('./system/SFTi.IOS/server/sw-core.js');

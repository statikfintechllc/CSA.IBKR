/**
 * SFTi DevBridge Client — bridge.js
 * Intercepts telemetry and polls for agent cards.
 * 
 * CRITICAL: Uses recursion guards on ALL interceptors to prevent
 * infinite loops when bridge internals call console/fetch.
 */

const BRIDGE_CONFIG = {
    serverUrl: "",
    pollInterval: 3000,
    flushInterval: 2000,
    maxBufferSize: 200,
    historyLimit: 50
};

class DevBridge {
    constructor() {
        this.buffer = [];
        this.cardHistory = [];
        this.isFlushing = false;
        this.isPolling = false;
        this.active = true;
        this.stats = { sent: 0, errors: 0, cards: 0 };
        this._insideInterceptor = false; // recursion guard

        // Stash raw originals BEFORE any wrapping
        this._origConsole = {};
        ['log','warn','error','info','debug'].forEach(l => {
            this._origConsole[l] = console[l].bind(console);
        });
        this._origFetch = window.fetch.bind(window);

        // Detect server URL
        // 1. Explicit global override (set by host app before loading bridge.js)
        // 2. data-server attribute on the script tag
        // 3. Infer from the script's own src URL
        // 4. Fallback: same origin as the page
        let detectedUrl = '';
        if (window.__DEVBRIDGE_URL) {
            detectedUrl = window.__DEVBRIDGE_URL;
        } else {
            // document.currentScript is null for dynamically-injected scripts,
            // so we scan all script tags for the one whose src contains 'bridge.js'
            const tag = document.currentScript
                || Array.from(document.querySelectorAll('script[src*="bridge.js"]')).pop();
            if (tag && tag.getAttribute('data-server')) {
                detectedUrl = tag.getAttribute('data-server');
            } else if (tag && tag.src) {
                const u = new URL(tag.src);
                detectedUrl = `${u.protocol}//${u.host}`;
            } else {
                detectedUrl = window.location.origin;
            }
        }
        this.serverUrl = detectedUrl;

        this._origConsole.log(`[Bridge] Initialized. Server: ${this.serverUrl}`);
        this._init();
    }

    // --- Safe internal helpers (bypass interceptors) ---
    _safeFetch(url, opts) {
        return this._origFetch(url, opts);
    }

    _safeLog(msg) {
        this._origConsole.log(msg);
    }

    // --- Init ---
    _init() {
        this._interceptConsole();
        this._interceptErrors();
        this._interceptNetwork();
        this._interceptStorage();
        this._interceptLifecycle();
        this._interceptWebSockets();
        this._startLoops();

        if (navigator.storage && navigator.storage.persist) {
            navigator.storage.persist().then(ok => {
                this._origConsole.log(`[Bridge] Storage persisted: ${ok}`);
            });
        }
    }

    // --- Interceptors ---

    _interceptConsole() {
        const self = this;
        ['log','warn','error','info','debug'].forEach(level => {
            const original = self._origConsole[level];
            console[level] = function(...args) {
                original(...args);
                if (self._insideInterceptor) return; // GUARD
                self._insideInterceptor = true;
                try {
                    self._enqueue('console', level, args.map(a =>
                        typeof a === 'object' ? JSON.stringify(a) : String(a)
                    ).join(' '));
                } finally {
                    self._insideInterceptor = false;
                }
            };
        });
    }

    _interceptErrors() {
        window.onerror = (msg, url, line, col, error) => {
            this._enqueue('error', 'error', String(msg), {
                url, line, col, stack: error?.stack
            });
        };
        window.onunhandledrejection = (event) => {
            this._enqueue('error', 'error', `Unhandled Promise: ${event.reason}`);
        };
    }

    _interceptNetwork() {
        const self = this;
        const origFetch = this._origFetch;

        // Check if a URL is bridge-internal
        const isBridgeUrl = (url) => {
            const s = String(url);
            // Match both relative bridge paths and full origin
            return s.includes(self.serverUrl) ||
                   s.startsWith('/log') ||
                   s.startsWith('/poll') ||
                   s.startsWith('/health') ||
                   s.startsWith('/card') ||
                   s.startsWith('/cards') ||
                   s.startsWith('/stream');
        };

        window.fetch = async function(...args) {
            const url = args[0] instanceof Request ? args[0].url : String(args[0]);
            if (isBridgeUrl(url)) return origFetch(...args);

            const start = Date.now();
            try {
                const response = await origFetch(...args);
                const duration = Date.now() - start;
                self._enqueue('network', 'info', `fetch ${response.status} ${url}`, {
                    method: args[1]?.method || 'GET',
                    status: response.status,
                    duration
                });
                return response;
            } catch (err) {
                self._enqueue('network', 'error', `fetch FAILED ${url}`, { error: err.message });
                throw err;
            }
        };

        // XHR wrapper
        const origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url) {
            this._url = url;
            this._method = method;
            this._start = Date.now();
            return origOpen.apply(this, arguments);
        };
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function() {
            if (!isBridgeUrl(this._url)) {
                this.addEventListener('load', () => {
                    self._enqueue('network', 'info', `XHR ${this.status} ${this._url}`, {
                        method: this._method,
                        status: this.status,
                        duration: Date.now() - this._start
                    });
                });
                this.addEventListener('error', () => {
                    self._enqueue('network', 'error', `XHR FAILED ${this._url}`);
                });
            }
            return origSend.apply(this, arguments);
        };
    }

    _interceptStorage() {
        const self = this;
        const wrap = (storage, name) => {
            const origSet = storage.setItem.bind(storage);
            storage.setItem = function(key, val) {
                origSet(key, val);
                self._enqueue('storage', 'debug', `${name} write: ${key}`);
            };
            const origRemove = storage.removeItem.bind(storage);
            storage.removeItem = function(key) {
                origRemove(key);
                self._enqueue('storage', 'debug', `${name} remove: ${key}`);
            };
        };
        try {
            wrap(localStorage, 'localStorage');
            wrap(sessionStorage, 'sessionStorage');
        } catch(e) {
            // Storage may be restricted in some contexts
        }
    }

    _interceptLifecycle() {
        document.addEventListener('visibilitychange', () => {
            this._enqueue('lifecycle', 'info', `Visibility: ${document.visibilityState}`);
            if (document.visibilityState === 'visible') {
                this.active = true;
                this._startLoops();
            }
        });
        window.addEventListener('online', () => this._enqueue('lifecycle', 'info', 'Connection: Online'));
        window.addEventListener('offline', () => this._enqueue('lifecycle', 'warn', 'Connection: Offline'));
    }

    _interceptWebSockets() {
        if (!window.WebSocket) return;
        const self = this;
        const origWS = window.WebSocket;
        window.WebSocket = function(url, protocols) {
            const ws = new origWS(url, protocols);
            self._enqueue('websocket', 'info', `WS Connecting: ${url}`);
            
            ws.addEventListener('open', () => self._enqueue('websocket', 'info', `WS Opened: ${url}`));
            ws.addEventListener('close', (e) => self._enqueue('websocket', 'warn', `WS Closed: ${url} (Code: ${e.code})`));
            ws.addEventListener('error', () => self._enqueue('websocket', 'error', `WS Error: ${url}`));
            
            // Note: We deliberately don't intercept every onmessage here as it could be extremely chatty,
            // but we register the connection hook.
            return ws;
        };
        // Preserve prototype chain
        window.WebSocket.prototype = origWS.prototype;
    }

    // --- Core ---

    _enqueue(source, level, message, data = {}) {
        const event = {
            ts: Date.now() / 1000,
            source,
            level,
            message,
            url: window.location.href,
            data
        };
        this.buffer.push(event);
        if (this.buffer.length > BRIDGE_CONFIG.maxBufferSize) {
            this.buffer.shift();
        }
        window.dispatchEvent(new CustomEvent('bridge_log', { detail: event }));
    }

    _startLoops() {
        if (this._flushTimer) clearInterval(this._flushTimer);
        if (this._pollTimer) clearInterval(this._pollTimer);
        this._flushTimer = setInterval(() => this._flush(), BRIDGE_CONFIG.flushInterval);
        this._pollTimer = setInterval(() => this._poll(), BRIDGE_CONFIG.pollInterval);
    }

    async _flush() {
        if (this.isFlushing || this.buffer.length === 0) return;
        this.isFlushing = true;

        const batch = this.buffer.splice(0, 30);
        try {
            const promises = batch.map(item =>
                this._safeFetch(`${this.serverUrl}/log`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(item)
                }).catch(() => {}) // silent drop, NO console.warn here
            );
            await Promise.all(promises);
            this.stats.sent += batch.length;
        } catch (e) {
            this.stats.errors++;
        } finally {
            this.isFlushing = false;
        }
    }

    async _poll() {
        if (this.isPolling) return;
        this.isPolling = true;
        try {
            const res = await this._safeFetch(`${this.serverUrl}/poll`);
            const { card } = await res.json();
            if (card) {
                this._executeCard(card);
            }
        } catch (e) {
            // silent
        } finally {
            this.isPolling = false;
        }
    }

    async _executeCard(card) {
        this._safeLog(`[Bridge] Executing card: ${card.id} (${card.type})`);
        this.stats.cards++;

        // Mark delivered
        await this._safeFetch(`${this.serverUrl}/card/${card.id}/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'delivered' })
        }).catch(() => {});

        let result;
        let status = 'completed';

        // Record in history
        const historyItem = { ...card, status: 'processing', timestamp: Date.now() };
        this.cardHistory.unshift(historyItem);
        if (this.cardHistory.length > BRIDGE_CONFIG.historyLimit) this.cardHistory.pop();

        try {
            switch (card.type) {
                case 'eval':
                    result = new Function(card.payload)();
                    break;
                case 'fetch':
                    const fRes = await this._origFetch(card.payload.url, card.payload.options);
                    result = { status: fRes.status, body: await fRes.text() };
                    break;
                case 'storage_read':
                    result = localStorage.getItem(card.payload.key);
                    break;
                case 'storage_write':
                    localStorage.setItem(card.payload.key, card.payload.val);
                    result = 'ok';
                    break;
                case 'reload':
                case 'refresh':
                    location.reload();
                    return;
                case 'screenshot':
                    result = await this._takeScreenshot();
                    break;
                case 'test':
                    result = await this._runTest(card.payload);
                    break;
                case 'click_element':
                    const elClick = document.querySelector(card.payload.selector);
                    if (elClick) {
                        elClick.click();
                        result = `Clicked ${card.payload.selector}`;
                    } else {
                        result = `Element ${card.payload.selector} not found`;
                    }
                    break;
                case 'query_selector':
                    const elQuery = document.querySelector(card.payload.selector);
                    if (elQuery) {
                        result = {
                            tagName: elQuery.tagName,
                            className: elQuery.className,
                            innerHTML: elQuery.innerHTML.substring(0, 500) // Truncated
                        };
                    } else {
                        result = 'Element not found';
                    }
                    break;
                case 'custom':
                    window.dispatchEvent(new CustomEvent('bridge_custom', { detail: card.payload }));
                    result = 'dispatched';
                    break;
                case 'csa_state':
                    if (window.CSA) {
                        result = {
                            environment: window.CSA.configLoader?.isLoaded() ? window.CSA.configLoader.get('environment') : 'not-loaded',
                            apiBase: window.CSA.configLoader?.isLoaded() ? window.CSA.configLoader.getApiBaseUrl() : null,
                            accountId: window.CSA.sessionManager?.accountId,
                            accounts: window.CSA.sessionManager?.accounts || [],
                            wsConnected: window.CSA.wsManager?.isConnected() || false
                        };
                    } else {
                        result = { error: 'window.CSA is not defined on the page' };
                    }
                    break;
                case 'webrtc_check':
                    result = {
                        supported: !!window.RTCPeerConnection,
                        mediaDevicesSupported: !!(navigator.mediaDevices && navigator.mediaDevices.enumerateDevices),
                    };
                    if (result.mediaDevicesSupported) {
                        try {
                            const devices = await navigator.mediaDevices.enumerateDevices();
                            result.devices = devices.length;
                        } catch (e) {}
                    }
                    break;
                default:
                    throw new Error(`Unknown card type: ${card.type}`);
            }
        } catch (err) {
            result = { error: err.message, stack: err.stack };
            status = 'failed';
        }

        // Report status (non-blocking, safe fetch)
        this._safeFetch(`${this.serverUrl}/card/${card.id}/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status })
        }).catch(() => {});

        // Update history
        const item = this.cardHistory.find(h => h.id === card.id);
        if (item) {
            item.status = status;
            item.result = result;
        }

        this._enqueue('card_result', status === 'completed' ? 'info' : 'error',
            `Card ${card.id} ${status}`, { cardId: card.id, result });
    }

    async _takeScreenshot() {
        if (!window.html2canvas) {
            await new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
                script.onload = resolve;
                script.onerror = reject;
                document.head.appendChild(script);
            });
        }
        const canvas = await html2canvas(document.body);
        return canvas.toDataURL('image/png');
    }

    async _runTest(testPayload) {
        const results = { passed: [], failed: [] };
        if (testPayload.assertions) {
            for (const [name, code] of Object.entries(testPayload.assertions)) {
                try {
                    const pass = new Function(`return ${code}`)();
                    if (pass) results.passed.push(name);
                    else results.failed.push(name);
                } catch (e) {
                    results.failed.push(`${name} (Error: ${e.message})`);
                }
            }
        }
        return results;
    }

    getHistory() {
        return this.cardHistory;
    }
}

// Global instance — no export, standard script
window.BRIDGE = new DevBridge();

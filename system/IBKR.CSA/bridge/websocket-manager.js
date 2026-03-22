/**
 * CSA.IBKR — WebSocket Manager (Bridge Layer)
 * Replaces: Vert.x WebSocket server relay to IBKR streaming
 *
 * Direct WSS connection to IBKR's streaming endpoint.
 * Implements the subscribe/unsubscribe topic protocol,
 * heartbeat keepalive, and auto-reconnect.
 *
 * Protocol: topic+argument format
 *   Subscribe:   smd+{conid}+{"fields":["31","83"]}
 *   Unsubscribe: umd+{conid}+{}
 *   Heartbeat:   ech+hb
 */

import logger from '../engine/logger.js';
import eventBus from '../engine/event-bus.js';
import configLoader from '../engine/config-loader.js';
import cookieManager from './cookie-manager.js';

const log = logger.child('WebSocketMgr');

// Connection states
const WSState = Object.freeze({
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  RECONNECTING: 'RECONNECTING',
  CLOSED: 'CLOSED'
});

// Heartbeat interval (IBKR recommends at least once per minute)
const HEARTBEAT_INTERVAL = 55000; // 55 seconds
const RECONNECT_BASE_DELAY = 2000;
const MAX_RECONNECT_DELAY = 60000;
const MAX_RECONNECT_ATTEMPTS = 10;

class WebSocketManager {
  #ws = null;
  #state = WSState.DISCONNECTED;
  #heartbeatTimer = null;
  #reconnectTimer = null;
  #reconnectAttempts = 0;
  #subscriptions = new Map(); // conid → { fields, callbacks }
  #autoReconnect = true;

  get state() { return this.#state; }
  get isConnected() { return this.#state === WSState.CONNECTED; }

  /**
   * Connect to IBKR WebSocket streaming endpoint.
   * @param {object} [options]
   * @param {boolean} [options.autoReconnect=true]
   * @returns {Promise<void>} Resolves when connected
   */
  connect(options = {}) {
    if (this.#ws && this.#state === WSState.CONNECTED) {
      log.debug('Already connected');
      return Promise.resolve();
    }

    this.#autoReconnect = options.autoReconnect !== false;

    return new Promise((resolve, reject) => {
      try {
        this.#state = WSState.CONNECTING;
        const config = configLoader.getConfig();
        const wsUrl = this.#buildWsUrl(config);
        log.info(`Connecting to WSS: ${wsUrl}`);

        this.#ws = new WebSocket(wsUrl);

        this.#ws.onopen = () => {
          this.#state = WSState.CONNECTED;
          this.#reconnectAttempts = 0;
          log.info('WebSocket connected');
          eventBus.emit('ws:connected', null, true);

          // Start heartbeat
          this.#startHeartbeat();

          // Resubscribe to previous subscriptions
          this.#resubscribeAll();

          resolve();
        };

        this.#ws.onmessage = (event) => {
          this.#handleMessage(event.data);
        };

        this.#ws.onclose = (event) => {
          log.info(`WebSocket closed: code=${event.code} reason=${event.reason}`);
          this.#state = WSState.DISCONNECTED;
          this.#stopHeartbeat();
          eventBus.emit('ws:disconnected', { code: event.code, reason: event.reason }, true);

          if (this.#autoReconnect && event.code !== 1000) {
            this.#scheduleReconnect();
          }
        };

        this.#ws.onerror = (event) => {
          log.error('WebSocket error');
          eventBus.emit('ws:error', { error: 'WebSocket connection error' });

          if (this.#state === WSState.CONNECTING) {
            reject(new Error('WebSocket connection failed'));
          }
        };
      } catch (err) {
        this.#state = WSState.DISCONNECTED;
        reject(err);
      }
    });
  }

  /**
   * Disconnect from WebSocket.
   */
  disconnect() {
    this.#autoReconnect = false;
    this.#stopHeartbeat();

    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }

    if (this.#ws) {
      this.#ws.close(1000, 'Client disconnect');
      this.#ws = null;
    }

    this.#state = WSState.CLOSED;
    log.info('WebSocket disconnected');
  }

  /**
   * Subscribe to market data for a contract.
   * @param {number|string} conid - Contract ID
   * @param {string[]} fields - Field IDs (e.g. ["31", "83", "84"])
   * @param {Function} [callback] - Optional per-subscription callback
   * @returns {Function} Unsubscribe function
   */
  subscribeMarketData(conid, fields, callback = null) {
    const key = `md:${conid}`;
    this.#subscriptions.set(key, { topic: 'smd', conid, fields, callback });

    if (this.isConnected) {
      this.#send(`smd+${conid}+${JSON.stringify({ fields })}`);
      log.debug(`Subscribed to market data: conid=${conid} fields=${fields}`);
      eventBus.emit('market:subscribed', { conid, fields });
    }

    return () => this.unsubscribeMarketData(conid);
  }

  /**
   * Unsubscribe from market data.
   * @param {number|string} conid
   */
  unsubscribeMarketData(conid) {
    const key = `md:${conid}`;
    this.#subscriptions.delete(key);

    if (this.isConnected) {
      this.#send(`umd+${conid}+{}`);
      log.debug(`Unsubscribed from market data: conid=${conid}`);
      eventBus.emit('market:unsubscribed', { conid });
    }
  }

  /**
   * Subscribe to live orders.
   * @param {Function} [callback]
   * @returns {Function} Unsubscribe function
   */
  subscribeOrders(callback = null) {
    this.#subscriptions.set('orders', { topic: 'sor', callback });

    if (this.isConnected) {
      this.#send('sor+{}');
      log.debug('Subscribed to live orders');
    }

    return () => this.unsubscribeOrders();
  }

  unsubscribeOrders() {
    this.#subscriptions.delete('orders');
    if (this.isConnected) this.#send('uor+{}');
  }

  /**
   * Subscribe to P&L updates.
   * @param {Function} [callback]
   * @returns {Function} Unsubscribe function
   */
  subscribePnL(callback = null) {
    this.#subscriptions.set('pnl', { topic: 'spl', callback });

    if (this.isConnected) {
      this.#send('spl+{}');
      log.debug('Subscribed to P&L');
    }

    return () => this.unsubscribePnL();
  }

  unsubscribePnL() {
    this.#subscriptions.delete('pnl');
    if (this.isConnected) this.#send('upl+{}');
  }

  /**
   * Send raw message to WebSocket.
   * @param {string} message
   */
  send(message) {
    this.#send(message);
  }

  // --- Private ---

  #buildWsUrl(config) {
    const host = config.apiHost.replace('https://', 'wss://').replace('http://', 'ws://');
    const base = config.portalBase || '';
    return `${host}${base}/${config.apiVersion}/api/ws`;
  }

  #send(message) {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
      log.warn(`Cannot send, WebSocket not open (state: ${this.#state})`);
      return false;
    }

    this.#ws.send(message);
    return true;
  }

  #handleMessage(raw) {
    try {
      const data = JSON.parse(raw);
      const topic = data.topic;

      switch (topic) {
        // --- Unsolicited Messages ---
        case 'system':
          if (data.success) {
            log.info(`System: authenticated as ${data.success}`);
          }
          if (data.hb) {
            log.trace(`System heartbeat: ${data.hb}`);
          }
          eventBus.emit('system:heartbeat', data);
          break;

        case 'sts':
          log.info('Auth status update:', data.args);
          eventBus.emit('session:status', data.args);
          if (data.args?.authenticated === false) {
            eventBus.emit('session:expired', data.args, true);
          }
          break;

        case 'ntf':
          log.info('Notification:', data.args);
          eventBus.emit('system:notification', data.args);
          break;

        case 'blt':
          log.warn('Bulletin:', data.args);
          eventBus.emit('system:bulletin', data.args);
          break;

        // --- Solicited Messages ---
        default:
          if (topic && topic.startsWith('smd+')) {
            // Market data update
            const conid = topic.replace('smd+', '');
            const sub = this.#subscriptions.get(`md:${conid}`);
            if (sub?.callback) sub.callback(data);
            eventBus.emit('market:data', { conid, ...data });
          } else if (topic === 'sor') {
            // Order update
            const sub = this.#subscriptions.get('orders');
            if (sub?.callback) sub.callback(data);
            eventBus.emit('orders:update', data.args || data);
          } else if (topic === 'spl') {
            // P&L update
            const sub = this.#subscriptions.get('pnl');
            if (sub?.callback) sub.callback(data);
            eventBus.emit('pnl:update', data.args || data);
          } else {
            log.debug('Unhandled WS message:', data);
          }
      }
    } catch {
      // Not JSON — might be echo heartbeat response
      if (raw === 'ech+hb') {
        log.trace('Heartbeat echo received');
      } else {
        log.debug('Non-JSON WS message:', raw);
      }
    }
  }

  #startHeartbeat() {
    this.#stopHeartbeat();
    this.#heartbeatTimer = setInterval(() => {
      this.#send('ech+hb');
    }, HEARTBEAT_INTERVAL);
    log.debug(`Heartbeat started (every ${HEARTBEAT_INTERVAL / 1000}s)`);
  }

  #stopHeartbeat() {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }

  #scheduleReconnect() {
    if (this.#reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      log.error(`Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached`);
      this.#state = WSState.CLOSED;
      eventBus.emit('ws:max_reconnects', null, true);
      return;
    }

    this.#state = WSState.RECONNECTING;
    const delay = Math.min(
      RECONNECT_BASE_DELAY * Math.pow(2, this.#reconnectAttempts) + Math.random() * 1000,
      MAX_RECONNECT_DELAY
    );

    log.info(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.#reconnectAttempts + 1})...`);

    this.#reconnectTimer = setTimeout(async () => {
      this.#reconnectAttempts++;
      try {
        await this.connect({ autoReconnect: this.#autoReconnect });
      } catch {
        this.#scheduleReconnect();
      }
    }, delay);
  }

  #resubscribeAll() {
    for (const [key, sub] of this.#subscriptions) {
      switch (sub.topic) {
        case 'smd':
          this.#send(`smd+${sub.conid}+${JSON.stringify({ fields: sub.fields })}`);
          break;
        case 'sor':
          this.#send('sor+{}');
          break;
        case 'spl':
          this.#send('spl+{}');
          break;
      }
    }

    if (this.#subscriptions.size > 0) {
      log.info(`Resubscribed to ${this.#subscriptions.size} stream(s)`);
    }
  }
}

// Singleton
const wsManager = new WebSocketManager();

export { WebSocketManager, wsManager, WSState };
export default wsManager;

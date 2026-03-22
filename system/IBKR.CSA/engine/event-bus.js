/**
 * CSA.IBKR — Event Bus (Engine Layer)
 * Replaces: Vert.x EventBus
 *
 * Pub/Sub event system with BroadcastChannel for cross-tab
 * and Service Worker communication.
 *
 * Events:
 *   'session:ready'       — Auth complete, session active
 *   'session:expired'     — Session timed out, re-auth needed
 *   'session:error'       — Auth/session error
 *   'market:data'         — Market data tick received
 *   'market:subscribed'   — Successfully subscribed to conid
 *   'market:unsubscribed' — Unsubscribed from conid
 *   'orders:update'       — Live order update
 *   'pnl:update'          — P&L update
 *   'ws:connected'        — WebSocket connected
 *   'ws:disconnected'     — WebSocket disconnected
 *   'ws:error'            — WebSocket error
 *   'system:heartbeat'    — System heartbeat from IBKR
 *   'system:notification' — IBKR notification
 *   'system:bulletin'     — IBKR bulletin
 *   'config:loaded'       — Config loaded successfully
 *   'ui:ready'            — UI initialized
 */

const CHANNEL_NAME = 'csa-ibkr-bus';

class EventBus {
  #listeners = new Map();
  #broadcastChannel = null;
  #crossTabEnabled = false;

  constructor() {
    // BroadcastChannel for cross-tab communication
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.#broadcastChannel = new BroadcastChannel(CHANNEL_NAME);
        this.#broadcastChannel.onmessage = (event) => {
          const { type, data, source } = event.data;
          if (source !== this.#instanceId) {
            this.#dispatch(type, data, true);
          }
        };
        this.#crossTabEnabled = true;
      } catch {
        // BroadcastChannel not available (e.g., some SW contexts)
      }
    }
  }

  // Unique ID for this instance to prevent echo
  #instanceId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  /**
   * Subscribe to an event.
   * @param {string} type - Event type (e.g. 'market:data')
   * @param {Function} handler - Callback function
   * @param {object} [options] - { once: boolean }
   * @returns {Function} Unsubscribe function
   */
  on(type, handler, options = {}) {
    if (!this.#listeners.has(type)) {
      this.#listeners.set(type, []);
    }

    const entry = { handler, once: !!options.once };
    this.#listeners.get(type).push(entry);

    // Return unsubscribe function
    return () => this.off(type, handler);
  }

  /**
   * Subscribe to an event (fires once then auto-unsubscribes).
   * @param {string} type - Event type
   * @param {Function} handler - Callback function
   * @returns {Function} Unsubscribe function
   */
  once(type, handler) {
    return this.on(type, handler, { once: true });
  }

  /**
   * Unsubscribe from an event.
   * @param {string} type - Event type
   * @param {Function} handler - The handler to remove
   */
  off(type, handler) {
    const entries = this.#listeners.get(type);
    if (!entries) return;

    const index = entries.findIndex(e => e.handler === handler);
    if (index !== -1) {
      entries.splice(index, 1);
    }
    if (entries.length === 0) {
      this.#listeners.delete(type);
    }
  }

  /**
   * Emit an event to all subscribers.
   * @param {string} type - Event type
   * @param {*} [data] - Event data payload
   * @param {boolean} [broadcast=false] - Also broadcast to other tabs
   */
  emit(type, data = null, broadcast = false) {
    this.#dispatch(type, data, false);

    // Broadcast to other tabs/SW
    if (broadcast && this.#crossTabEnabled && this.#broadcastChannel) {
      try {
        this.#broadcastChannel.postMessage({
          type,
          data,
          source: this.#instanceId
        });
      } catch {
        // Serialization error — data not cloneable
      }
    }
  }

  /**
   * Wait for an event as a Promise.
   * @param {string} type - Event type to wait for
   * @param {number} [timeout=30000] - Timeout in ms (0 = no timeout)
   * @returns {Promise<*>} Resolves with event data
   */
  waitFor(type, timeout = 30000) {
    return new Promise((resolve, reject) => {
      let timer;
      const unsub = this.once(type, (data) => {
        if (timer) clearTimeout(timer);
        resolve(data);
      });

      if (timeout > 0) {
        timer = setTimeout(() => {
          unsub();
          reject(new Error(`[EventBus] Timeout waiting for event: ${type}`));
        }, timeout);
      }
    });
  }

  /**
   * Remove all listeners for a type, or all listeners entirely.
   * @param {string} [type] - Event type (omit to clear all)
   */
  clear(type) {
    if (type) {
      this.#listeners.delete(type);
    } else {
      this.#listeners.clear();
    }
  }

  /**
   * Get count of listeners for a type.
   * @param {string} type
   * @returns {number}
   */
  listenerCount(type) {
    return this.#listeners.get(type)?.length || 0;
  }

  /**
   * Destroy the event bus and close BroadcastChannel.
   */
  destroy() {
    this.#listeners.clear();
    if (this.#broadcastChannel) {
      this.#broadcastChannel.close();
      this.#broadcastChannel = null;
    }
  }

  // --- Private ---

  #dispatch(type, data, fromBroadcast) {
    const entries = this.#listeners.get(type);
    if (!entries || entries.length === 0) return;

    // Copy array to allow modification during iteration
    const snapshot = [...entries];
    for (const entry of snapshot) {
      try {
        entry.handler(data);
      } catch (err) {
        console.error(`[EventBus] Error in handler for "${type}":`, err);
      }
      if (entry.once) {
        this.off(type, entry.handler);
      }
    }
  }
}

// Singleton instance
const eventBus = new EventBus();

export { EventBus, eventBus };
export default eventBus;

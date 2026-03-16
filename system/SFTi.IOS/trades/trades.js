/**
 * SFTi.IOS/trades/trades.js — Trade Execution Widget
 *
 * Provides order placement and management via the IBKR CP Gateway REST API.
 *
 * Features:
 *   - Place limit / market / stop / stop-limit orders
 *   - Modify or cancel open orders
 *   - Stream live order status updates via WebSocket
 *   - Persist order history client-side in the Vault
 */

import { Vault } from '../storage/vault.js';

const ORDER_HISTORY_KEY = 'order_history';
const MAX_HISTORY = 200;

export class Trades {
  constructor({ accountId, onLog } = {}) {
    this._accountId = accountId;
    this._onLog = onLog || console.log;
    this._vault = new Vault('sfti.ios.trades');
  }

  /**
   * Place an order.
   *
   * @param {object} order
   * @param {string} order.ticker       e.g. "AAPL"
   * @param {string} order.action       "BUY" | "SELL"
   * @param {string} order.orderType    "LMT" | "MKT" | "STP" | "STP LMT"
   * @param {number} order.quantity
   * @param {number} [order.lmtPrice]
   * @param {number} [order.auxPrice]   Stop price for STP orders
   * @param {string} [order.tif]        "DAY" | "GTC" | "IOC" (default: "DAY")
   * @returns {Promise<{orderId: string, status: string}>}
   */
  async placeOrder(order) {
    const body = {
      acctId: this._accountId,
      conid: await this._resolveConid(order.ticker),
      orderType: order.orderType || 'LMT',
      side: order.action,
      quantity: order.quantity,
      tif: order.tif || 'DAY',
      price: order.lmtPrice,
      auxPrice: order.auxPrice,
    };

    const resp = await this._api(`/v1/api/iserver/account/${this._accountId}/orders`, 'POST', body);

    await this._appendHistory({
      ...order,
      orderId: resp?.orderId || resp?.order_id,
      status: resp?.order_status || 'submitted',
      ts: Date.now(),
    });

    return resp;
  }

  /**
   * Cancel an open order.
   * @param {string} orderId
   */
  async cancelOrder(orderId) {
    return this._api(`/v1/api/iserver/account/${this._accountId}/order/${orderId}`, 'DELETE');
  }

  /**
   * Modify an existing order.
   * @param {string} orderId
   * @param {object} updates  Fields to update (lmtPrice, quantity, etc.)
   */
  async modifyOrder(orderId, updates) {
    return this._api(
      `/v1/api/iserver/account/${this._accountId}/order/${orderId}`,
      'POST',
      updates
    );
  }

  /**
   * Get all live orders for the account.
   * @returns {Promise<object[]>}
   */
  async getLiveOrders() {
    return this._api('/v1/api/iserver/account/orders');
  }

  /**
   * Get live positions for the account.
   * @returns {Promise<object[]>}
   */
  async getPositions() {
    return this._api(`/v1/api/portfolio/${this._accountId}/positions/0`);
  }

  /**
   * Get stored order history (client-side).
   * @returns {Promise<object[]>}
   */
  async getHistory() {
    return (await this._vault.get(ORDER_HISTORY_KEY)) || [];
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  async _resolveConid(ticker) {
    const resp = await this._api(`/v1/api/iserver/secdef/search?symbol=${encodeURIComponent(ticker)}&name=false&secType=STK`);
    const contracts = resp?.contracts || resp || [];
    if (!contracts.length) throw new Error(`No contract found for ${ticker}`);
    return contracts[0].conid;
  }

  async _api(path, method = 'GET', body) {
    const init = {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    };
    if (body) init.body = JSON.stringify(body);
    const resp = await fetch(path, init);
    if (!resp.ok) throw new Error(`IBKR API error ${resp.status}: ${await resp.text()}`);
    return resp.json();
  }

  async _appendHistory(order) {
    const history = await this.getHistory();
    history.unshift(order);
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    await this._vault.set(ORDER_HISTORY_KEY, history);
  }
}

export default Trades;

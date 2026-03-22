/**
 * CSA.IBKR — Gateway Client (Bridge Layer)
 * Replaces: Vert.x ProxyHandler + HttpClient reverse proxy
 *
 * High-level API client exposing all IBKR Client Portal REST endpoints.
 * All methods use fetch() and return Promises.
 */

import logger from '../engine/logger.js';
import configLoader from '../engine/config-loader.js';
import { classifyError, handleError, withRetry } from '../engine/error-handler.js';
import cookieManager from './cookie-manager.js';

const log = logger.child('GatewayClient');

class GatewayClient {

  /**
   * Make an authenticated API request to IBKR.
   * @param {string} endpoint - API path (e.g. '/iserver/accounts')
   * @param {object} [options]
   * @param {string} [options.method='GET']
   * @param {object} [options.body] - Request body (auto-serialized to JSON)
   * @param {object} [options.headers] - Additional headers
   * @param {boolean} [options.retry=true] - Enable retry for recoverable errors
   * @returns {Promise<object>} Parsed JSON response
   */
  async request(endpoint, options = {}) {
    const { method = 'GET', body, headers = {}, retry = true } = options;
    const baseUrl = configLoader.getApiBaseUrl();
    const url = `${baseUrl}${endpoint}`;

    const doRequest = async () => {
      const requestInit = {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...cookieManager.getAuthHeaders(),
          ...headers
        },
        credentials: 'include'
      };

      if (body && method !== 'GET' && method !== 'HEAD') {
        requestInit.body = JSON.stringify(body);
      }

      log.debug(`${method} ${endpoint}`);

      const response = await fetch(url, requestInit);

      if (!response.ok) {
        const error = classifyError(response, endpoint);
        handleError(error, { silent: false });
        throw error;
      }

      // Handle empty responses
      const contentType = response.headers.get('content-type') || '';
      if (response.status === 204 || !contentType.includes('application/json')) {
        return { ok: true, status: response.status };
      }

      return await response.json();
    };

    if (retry) {
      return withRetry(doRequest, { maxRetries: 2 });
    }
    return doRequest();
  }

  // ==========================================
  // SESSION / AUTH ENDPOINTS
  // ==========================================

  /** Check authentication status */
  async getAuthStatus() {
    return this.request('/iserver/auth/status', { method: 'POST' });
  }

  /** Send keepalive tickle */
  async tickle() {
    return this.request('/tickle', { method: 'POST' });
  }

  /** Logout */
  async logout() {
    return this.request('/logout', { method: 'POST', retry: false });
  }

  /** Initialize SSO session */
  async ssoInit() {
    return this.request('/ssodh/init', { method: 'GET' });
  }

  /** Reauthenticate */
  async reauthenticate() {
    return this.request('/iserver/reauthenticate', { method: 'POST' });
  }

  // ==========================================
  // ACCOUNT ENDPOINTS
  // ==========================================

  /** Get brokerage accounts */
  async getAccounts() {
    return this.request('/iserver/accounts');
  }

  /** Get portfolio accounts (call before other /portfolio endpoints) */
  async getPortfolioAccounts() {
    return this.request('/portfolio/accounts');
  }

  /** Get account summary */
  async getAccountSummary(accountId) {
    return this.request(`/portfolio/${accountId}/summary`);
  }

  /** Get account ledger */
  async getAccountLedger(accountId) {
    return this.request(`/portfolio/${accountId}/ledger`);
  }

  /** Get account P&L */
  async getAccountPnL() {
    return this.request('/iserver/account/pnl/partitioned');
  }

  /** Switch active account (for multi-account users) */
  async switchAccount(accountId) {
    return this.request('/iserver/account', {
      method: 'POST',
      body: { acctId: accountId }
    });
  }

  // ==========================================
  // MARKET DATA ENDPOINTS
  // ==========================================

  /**
   * Get market data snapshot for contract(s).
   * @param {string|number|Array} conids - Contract ID(s)
   * @param {string[]} fields - Field IDs (e.g. ['31','83','84','85','86','88'])
   * @returns {Promise<Array>} Market data snapshots
   */
  async getMarketDataSnapshot(conids, fields) {
    const conidStr = Array.isArray(conids) ? conids.join(',') : String(conids);
    const fieldStr = Array.isArray(fields) ? fields.join(',') : String(fields);
    return this.request(`/iserver/marketdata/snapshot?conids=${conidStr}&fields=${fieldStr}`);
  }

  /**
   * Get historical market data.
   * @param {string|number} conid - Contract ID
   * @param {string} period - e.g. '1d', '1w', '1m', '1y'
   * @param {string} bar - Bar size: '1min', '5min', '1h', '1d', etc.
   * @param {object} [options]
   * @param {boolean} [options.outsideRth=false] - Include outside regular trading hours
   * @returns {Promise<object>} Historical data bars
   */
  async getHistoricalData(conid, period, bar, options = {}) {
    const params = new URLSearchParams({
      conid: String(conid),
      period,
      bar,
      outsideRth: String(options.outsideRth || false)
    });
    return this.request(`/iserver/marketdata/history?${params}`);
  }

  /**
   * Get historical data via HMDS (alternate endpoint).
   * @param {string|number} conid
   * @param {string} period
   * @param {string} bar
   * @returns {Promise<object>}
   */
  async getHmdsHistory(conid, period, bar) {
    const params = new URLSearchParams({
      conid: String(conid),
      period,
      bar
    });
    return this.request(`/hmds/history?${params}`);
  }

  // ==========================================
  // SECURITY / CONTRACT SEARCH
  // ==========================================

  /**
   * Search for a security by symbol.
   * @param {string} symbol - Ticker symbol (e.g. 'AAPL')
   * @param {string} [secType] - Security type filter: 'STK', 'OPT', 'FUT', etc.
   * @returns {Promise<Array>} Search results with conids
   */
  async searchSecurity(symbol, secType = null) {
    const body = { symbol };
    if (secType) body.secType = secType;
    return this.request('/iserver/secdef/search', { method: 'POST', body });
  }

  /**
   * Get contract info by conid.
   * @param {string|number} conid
   * @returns {Promise<object>} Contract details
   */
  async getContractInfo(conid) {
    return this.request(`/iserver/contract/${conid}/info`);
  }

  /**
   * Get security definition info.
   * @param {string|number} conid
   * @returns {Promise<object>}
   */
  async getSecDefInfo(conid) {
    return this.request(`/iserver/secdef/info?conid=${conid}`);
  }

  /**
   * Get futures for an underlying.
   * @param {string} symbol
   * @returns {Promise<object>}
   */
  async getFutures(symbol) {
    return this.request(`/trsrv/futures?symbols=${symbol}`);
  }

  // ==========================================
  // ORDER ENDPOINTS
  // ==========================================

  /**
   * Place an order.
   * @param {string} accountId
   * @param {object} order - Order specification
   * @param {string} order.conid - Contract ID
   * @param {string} order.side - 'BUY' or 'SELL'
   * @param {string} order.orderType - 'LMT', 'MKT', 'STP', etc.
   * @param {number} order.quantity
   * @param {number} [order.price] - Required for limit orders
   * @param {string} [order.tif='GTC'] - Time in force
   * @returns {Promise<object>} Order confirmation (may require reply)
   */
  async placeOrder(accountId, order) {
    return this.request(`/iserver/account/${accountId}/orders`, {
      method: 'POST',
      body: { orders: [order] }
    });
  }

  /**
   * Reply to order confirmation (e.g. accept warning).
   * @param {string} replyId - Reply ID from place order response
   * @param {boolean} confirmed - Whether to confirm
   * @returns {Promise<object>}
   */
  async replyOrder(replyId, confirmed = true) {
    return this.request(`/iserver/reply/${replyId}`, {
      method: 'POST',
      body: { confirmed }
    });
  }

  /**
   * Get today's orders.
   * @param {object} [options]
   * @param {boolean} [options.force=false]
   * @returns {Promise<object>}
   */
  async getOrders(options = {}) {
    const force = options.force ? 'true' : 'false';
    return this.request(`/iserver/account/orders?force=${force}`);
  }

  /**
   * Cancel an order.
   * @param {string} accountId
   * @param {string} orderId
   * @returns {Promise<object>}
   */
  async cancelOrder(accountId, orderId) {
    return this.request(`/iserver/account/${accountId}/order/${orderId}`, {
      method: 'DELETE'
    });
  }

  /**
   * Modify an existing order.
   * @param {string} accountId
   * @param {string} orderId
   * @param {object} modifications
   * @returns {Promise<object>}
   */
  async modifyOrder(accountId, orderId, modifications) {
    return this.request(`/iserver/account/${accountId}/order/${orderId}`, {
      method: 'PUT',
      body: modifications
    });
  }

  // ==========================================
  // PORTFOLIO / POSITIONS
  // ==========================================

  /**
   * Get positions for an account.
   * @param {string} accountId
   * @param {number} [page=0] - Page number (30 per page)
   * @returns {Promise<Array>}
   */
  async getPositions(accountId, page = 0) {
    return this.request(`/portfolio/${accountId}/positions/${page}`);
  }

  /**
   * Get position for a specific contract.
   * @param {string} accountId
   * @param {string|number} conid
   * @returns {Promise<object>}
   */
  async getPositionByConid(accountId, conid) {
    return this.request(`/portfolio/${accountId}/position/${conid}`);
  }

  // ==========================================
  // ALERTS
  // ==========================================

  /** Get alerts for an account */
  async getAlerts(accountId) {
    return this.request(`/iserver/account/${accountId}/alerts`);
  }

  /** Create or modify alert */
  async createAlert(alertData) {
    return this.request('/iserver/account/alert', {
      method: 'POST',
      body: alertData
    });
  }

  /** Delete an alert */
  async deleteAlert(accountId, alertId) {
    return this.request(`/iserver/account/${accountId}/alert/${alertId}`, {
      method: 'DELETE'
    });
  }

  // ==========================================
  // SCANNER
  // ==========================================

  /** Get scanner parameters (available scan types, instruments, etc.) */
  async getScannerParams() {
    return this.request('/iserver/scanner/params');
  }

  /**
   * Run a market scanner.
   * @param {object} scannerSpec - Scanner specification
   * @returns {Promise<object>}
   */
  async runScanner(scannerSpec) {
    return this.request('/iserver/scanner/run', {
      method: 'POST',
      body: scannerSpec
    });
  }
}

// Singleton
const gatewayClient = new GatewayClient();

export { GatewayClient, gatewayClient };
export default gatewayClient;

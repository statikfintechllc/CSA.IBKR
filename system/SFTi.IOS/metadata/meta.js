/**
 * SFTi.IOS/metadata/meta.js — App & Market Metadata
 *
 * Caches and retrieves company fundamentals, contract details,
 * and market metadata from the IBKR gateway REST API.
 */

import { Vault } from '../storage/vault.js';

const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

export class Meta {
  constructor({ onLog } = {}) {
    this._onLog = onLog || console.log;
    this._vault = new Vault('sfti.ios.metadata');
  }

  /**
   * Get company fundamentals for a ticker.
   * @param {string} ticker
   * @returns {Promise<object>}
   */
  async getFundamentals(ticker) {
    const cacheKey = `fundamentals::${ticker}`;
    const cached = await this._vault.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

    const conid = await this._resolveConid(ticker);
    const data = await this._api(`/v1/api/iserver/fundamentals/financials?conid=${conid}&reports=summary`);
    await this._vault.set(cacheKey, { data, ts: Date.now() });
    return data;
  }

  /**
   * Get latest news headlines for a ticker.
   * @param {string} ticker
   * @param {number} [limit=10]
   * @returns {Promise<object[]>}
   */
  async getNews(ticker, limit = 10) {
    const conid = await this._resolveConid(ticker);
    return this._api(`/v1/api/iserver/news?conid=${conid}&limit=${limit}`);
  }

  /**
   * Get contract details for a ticker.
   * @param {string} ticker
   * @returns {Promise<object>}
   */
  async getContractDetails(ticker) {
    const cacheKey = `contract::${ticker}`;
    const cached = await this._vault.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

    const data = await this._api(
      `/v1/api/iserver/secdef/search?symbol=${encodeURIComponent(ticker)}&name=false&secType=STK`
    );
    await this._vault.set(cacheKey, { data, ts: Date.now() });
    return data;
  }

  /**
   * Get realtime market snapshot (bid/ask/last/volume).
   * @param {string} ticker
   * @returns {Promise<object>}
   */
  async getSnapshot(ticker) {
    const conid = await this._resolveConid(ticker);
    return this._api(`/v1/api/iserver/marketdata/snapshot?conids=${conid}&fields=31,84,86,7762,7296`);
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  async _resolveConid(ticker) {
    const cacheKey = `conid::${ticker}`;
    const cached = await this._vault.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

    const resp = await this._api(
      `/v1/api/iserver/secdef/search?symbol=${encodeURIComponent(ticker)}&name=false&secType=STK`
    );
    const contracts = resp?.contracts || resp || [];
    if (!contracts.length) throw new Error(`No contract found for ticker: ${ticker}`);
    const conid = contracts[0].conid;
    await this._vault.set(cacheKey, { data: conid, ts: Date.now() });
    return conid;
  }

  async _api(path) {
    const resp = await fetch(path, { credentials: 'include' });
    if (!resp.ok) throw new Error(`API error ${resp.status}`);
    return resp.json();
  }
}

export default Meta;

/**
 * SFTi.IOS/monthlies/monthlies.js — Monthly Options & Expiry Calendar
 *
 * Fetches, caches, and renders monthly expiry data from the IBKR gateway:
 *   - All available expiry dates for an equity
 *   - Open Interest and IV by strike for a given expiry
 *   - Calendar view of key events (earnings, dividends, ex-dates)
 */

import { Vault } from '../storage/vault.js';

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export class Monthlies {
  constructor({ onLog } = {}) {
    this._onLog = onLog || console.log;
    this._vault = new Vault('sfti.ios.monthlies');
  }

  /**
   * Get all monthly option expiry dates for a ticker.
   * @param {string} ticker
   * @param {number} conid   Contract ID (from meta.js)
   * @returns {Promise<string[]>}  ISO date strings
   */
  async getExpiryDates(ticker, conid) {
    const key = `expiries::${ticker}`;
    const cached = await this._vault.get(key);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

    const resp = await this._api(`/v1/api/iserver/secdef/strikes?conid=${conid}&sectype=OPT&month=`);
    const dates = resp?.call?.map?.((s) => s.expirationDate) || [];
    const monthly = dates.filter((d) => this._isMonthlyExpiry(d));
    await this._vault.set(key, { data: monthly, ts: Date.now() });
    return monthly;
  }

  /**
   * Get the options chain (strikes, OI, IV) for a given expiry.
   * @param {number} conid
   * @param {string} expiry  "YYYYMMDD"
   * @returns {Promise<{calls: object[], puts: object[]}>}
   */
  async getChain(conid, expiry) {
    const key = `chain::${conid}::${expiry}`;
    const cached = await this._vault.get(key);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

    const resp = await this._api(
      `/v1/api/iserver/secdef/strikes?conid=${conid}&sectype=OPT&month=${expiry.slice(0, 6)}&exchange=SMART`
    );
    await this._vault.set(key, { data: resp, ts: Date.now() });
    return resp;
  }

  /**
   * Get upcoming earnings and dividends calendar for a ticker.
   * @param {number} conid
   * @returns {Promise<object[]>}
   */
  async getCalendar(conid) {
    return this._api(`/v1/api/iserver/fundamentals/calendar?conid=${conid}`);
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  _isMonthlyExpiry(dateStr) {
    // Standard monthly options expire the 3rd Friday of the month
    const d = new Date(
      parseInt(dateStr.slice(0, 4)),
      parseInt(dateStr.slice(4, 6)) - 1,
      parseInt(dateStr.slice(6, 8))
    );
    if (d.getDay() !== 5) return false; // Must be Friday
    const dayOfMonth = d.getDate();
    return dayOfMonth >= 15 && dayOfMonth <= 21; // 3rd Friday
  }

  async _api(path) {
    const resp = await fetch(path, { credentials: 'include' });
    if (!resp.ok) throw new Error(`API ${resp.status}: ${path}`);
    return resp.json();
  }
}

export default Monthlies;

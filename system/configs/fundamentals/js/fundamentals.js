/**
 * configs/fundamentals/js/fundamentals.js
 * Renders the fundamentals panel for a ticker.
 */

import { Meta } from '../../../SFTi.IOS/metadata/meta.js';

export class FundamentalsPanel {
  /**
   * @param {HTMLElement} container
   */
  constructor(container) {
    this._el = container;
    this._meta = new Meta();
  }

  async load(ticker) {
    this._el.innerHTML = '<div class="fund-loading">Loading fundamentals…</div>';
    try {
      const [snapshot, details] = await Promise.all([
        this._meta.getSnapshot(ticker).catch(() => null),
        this._meta.getContractDetails(ticker).catch(() => null),
      ]);
      this._render(ticker, snapshot, details);
    } catch (err) {
      this._el.innerHTML = `<div class="fund-error">Could not load fundamentals: ${err.message}</div>`;
    }
  }

  _render(ticker, snapshot, details) {
    const contracts = details?.contracts || details || [];
    const contract = contracts[0] || {};
    const snap = Array.isArray(snapshot) ? snapshot[0] : (snapshot || {});

    const last = snap['31'] || snap.last || '—';
    const bid = snap['84'] || snap.bid || '—';
    const ask = snap['86'] || snap.ask || '—';
    const change = snap['7762'] || snap.change || '—';
    const pct = snap['7296'] || snap.changePct || '—';

    const positive = parseFloat(change) >= 0;

    this._el.innerHTML = `
      <div class="fund-header">
        <span class="fund-ticker">${ticker}</span>
        <span class="fund-name">${contract.companyName || contract.description || ''}</span>
      </div>
      <div class="fund-price-row">
        <span class="fund-last">${last}</span>
        <span class="fund-change ${positive ? 'up' : 'down'}">${change} (${pct}%)</span>
      </div>
      <div class="fund-grid">
        <div class="fund-kv"><span class="fk">Bid</span><span class="fv">${bid}</span></div>
        <div class="fund-kv"><span class="fk">Ask</span><span class="fv">${ask}</span></div>
        <div class="fund-kv"><span class="fk">Exchange</span><span class="fv">${contract.primaryExch || contract.exchange || '—'}</span></div>
        <div class="fund-kv"><span class="fk">Currency</span><span class="fv">${contract.currency || '—'}</span></div>
        <div class="fund-kv"><span class="fk">Type</span><span class="fv">${contract.secType || 'STK'}</span></div>
        <div class="fund-kv"><span class="fk">ConID</span><span class="fv">${contract.conid || '—'}</span></div>
      </div>
    `;
  }
}

export default FundamentalsPanel;

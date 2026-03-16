/**
 * configs/ticker.input/js/ticker.js
 * Ticker search input with autocomplete and recent-ticker history.
 */

import { Vault } from '../../../SFTi.IOS/storage/vault.js';

const RECENT_KEY = 'recent_tickers';
const MAX_RECENT = 10;

export class TickerInput {
  /**
   * @param {HTMLInputElement} inputEl
   * @param {function} onSelect  Called with (ticker: string)
   */
  constructor(inputEl, onSelect) {
    this._input = inputEl;
    this._onSelect = onSelect;
    this._vault = new Vault('sfti.ticker');
    this._suggestions = [];
    this._dropdown = null;
    this._init();
  }

  /** Build the dropdown and bind events. */
  _init() {
    this._dropdown = document.createElement('div');
    this._dropdown.className = 'ticker-dropdown';
    this._input.parentElement.appendChild(this._dropdown);

    this._input.addEventListener('input', () => this._handleInput());
    this._input.addEventListener('keydown', (e) => this._handleKey(e));
    this._input.addEventListener('focus', () => this._showRecent());
    document.addEventListener('click', (e) => {
      if (!this._input.contains(e.target) && !this._dropdown.contains(e.target)) {
        this._hideDropdown();
      }
    });
  }

  async _handleInput() {
    const q = this._input.value.trim().toUpperCase();
    if (!q) { this._showRecent(); return; }
    if (q.length < 1) return;

    try {
      const resp = await fetch(
        `/v1/api/iserver/secdef/search?symbol=${encodeURIComponent(q)}&name=false&secType=STK`,
        { credentials: 'include' }
      );
      const data = await resp.json();
      const contracts = data?.contracts || data || [];
      const tickers = contracts.slice(0, 8).map((c) => ({
        ticker: c.symbol || c.ticker,
        name: c.companyName || c.description || '',
      }));
      this._showSuggestions(tickers);
    } catch (_) {
      // Offline fallback — just show what user typed
      this._showSuggestions([{ ticker: q, name: '' }]);
    }
  }

  async _showRecent() {
    const recent = (await this._vault.get(RECENT_KEY)) || [];
    if (!recent.length) return;
    this._showSuggestions(recent.map((t) => ({ ticker: t, name: 'Recent' })));
  }

  _showSuggestions(items) {
    this._suggestions = items;
    this._dropdown.innerHTML = '';
    items.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'ticker-suggestion';
      row.innerHTML = `<span class="ts-symbol">${item.ticker}</span><span class="ts-name">${item.name}</span>`;
      row.addEventListener('click', () => this._select(item.ticker));
      this._dropdown.appendChild(row);
    });
    this._dropdown.classList.add('visible');
  }

  _hideDropdown() {
    this._dropdown.classList.remove('visible');
  }

  _handleKey(e) {
    if (e.key === 'Enter') {
      const q = this._input.value.trim().toUpperCase();
      if (q) this._select(q);
    }
    if (e.key === 'Escape') this._hideDropdown();
  }

  async _select(ticker) {
    this._input.value = ticker;
    this._hideDropdown();
    this._onSelect(ticker);
    await this._saveRecent(ticker);
  }

  async _saveRecent(ticker) {
    let recent = (await this._vault.get(RECENT_KEY)) || [];
    recent = [ticker, ...recent.filter((t) => t !== ticker)].slice(0, MAX_RECENT);
    await this._vault.set(RECENT_KEY, recent);
  }
}

export default TickerInput;

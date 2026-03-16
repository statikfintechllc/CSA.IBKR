/**
 * configs/main.chart/js/dynamics.js
 * Dynamic behaviour for the main chart: data fetching, indicator wiring,
 * real-time streaming subscriptions, and refresh scheduling.
 */

import { EMA } from '../../../SFTi.CIPs/EMA.js';
import { RSI } from '../../../SFTi.CIPs/RSI.js';
import { MACD } from '../../../SFTi.CIPs/MACD.js';
import { BB } from '../../../SFTi.CIPs/BB.js';

const DEFAULT_BAR_ENDPOINT = '/v1/api/iserver/marketdata/history';

export class ChartDynamics {
  /**
   * @param {import('../../../SFTi.CRPs/CandleChart.js').CandleChart} chart
   */
  constructor(chart) {
    this._chart = chart;
    this._ticker = null;
    this._period = '1d';   // bar period
    this._range = '3m';    // date range
    this._wsConn = null;
    this._refreshTimer = null;
  }

  /** Load and display data for a ticker. */
  async load(ticker, period = '1d', range = '3m') {
    this._ticker = ticker;
    this._period = period;
    this._range = range;

    const candles = await this._fetchCandles(ticker, period, range);
    this._chart.setData(candles);

    const closes = candles.map((c) => c.close);

    // Overlay: EMA 20 + EMA 50
    this._chart.addOverlay(EMA(closes, 20), { color: '#00d4ff', label: 'EMA 20', lineWidth: 1.5 });
    this._chart.addOverlay(EMA(closes, 50), { color: '#ffb700', label: 'EMA 50', lineWidth: 1.5 });

    // Bollinger Bands
    const { upper, middle, lower } = BB(closes, 20);
    this._chart.addOverlay(upper, { color: 'rgba(167,139,250,0.6)', label: 'BB Upper', lineWidth: 1 });
    this._chart.addOverlay(lower, { color: 'rgba(167,139,250,0.6)', label: 'BB Lower', lineWidth: 1 });

    // RSI sub-panel
    const rsi = RSI(closes, 14);
    this._chart.addSubPanel({
      data: rsi,
      label: 'RSI 14',
      color: '#f59e0b',
      range: [0, 100],
      refLines: [70, 30],
    });

    // MACD histogram sub-panel
    const { histogram } = MACD(closes);
    this._chart.addSubPanel({
      data: histogram,
      label: 'MACD',
      color: '#818cf8',
    });

    this._subscribeRealtime(ticker, period);
  }

  /** Switch bar period and reload. */
  async setPeriod(period) {
    await this.load(this._ticker, period, this._range);
  }

  /** Unsubscribe from streaming and cancel timers. */
  destroy() {
    if (this._wsConn) { this._wsConn.close(); this._wsConn = null; }
    clearInterval(this._refreshTimer);
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  async _fetchCandles(ticker, period, range) {
    try {
      const resp = await fetch(
        `${DEFAULT_BAR_ENDPOINT}?symbol=${encodeURIComponent(ticker)}&period=${period}&bar=${range}&outsideRth=false`,
        { credentials: 'include' }
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      const bars = json?.data || json?.bars || json || [];
      return bars.map((b) => ({
        time: b.t || b.time,
        open: b.o || b.open,
        high: b.h || b.high,
        low: b.l || b.low,
        close: b.c || b.close,
        volume: b.v || b.volume || 0,
      }));
    } catch (err) {
      console.warn('[ChartDynamics] Fetch failed, using demo data:', err.message);
      return this._demoCandles(ticker);
    }
  }

  _subscribeRealtime(ticker, period) {
    if (period !== '1m' && period !== '5m') return;
    // Refresh every 60s for short-term bars
    this._refreshTimer = setInterval(() => this.load(ticker, period, this._range), 60_000);
  }

  /** Generate plausible demo candle data for offline/preview mode. */
  _demoCandles(ticker) {
    const candles = [];
    let price = 180 + Math.random() * 20;
    const now = Date.now();
    for (let i = 90; i >= 0; i--) {
      const o = price;
      const c = price + (Math.random() - 0.48) * 3;
      const h = Math.max(o, c) + Math.random() * 2;
      const l = Math.min(o, c) - Math.random() * 2;
      candles.push({
        time: now - i * 86400000,
        open: +o.toFixed(2),
        high: +h.toFixed(2),
        low: +l.toFixed(2),
        close: +c.toFixed(2),
        volume: Math.round(10e6 + Math.random() * 40e6),
      });
      price = c;
    }
    return candles;
  }
}

export default ChartDynamics;

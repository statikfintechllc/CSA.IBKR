/**
 * SFTi.CIPs/BB.js — Bollinger Bands (20, 2σ standard)
 *
 * Classic Bollinger Bands:
 *   Middle Band = SMA(20)
 *   Upper Band  = SMA(20) + 2 × σ
 *   Lower Band  = SMA(20) − 2 × σ
 *   %B          = (close − lower) / (upper − lower)
 *   Bandwidth   = (upper − lower) / middle
 *
 * @param {number[]} closes      Closing prices (oldest first)
 * @param {number}   [period=20]
 * @param {number}   [mult=2]    Standard deviation multiplier
 * @returns {{ upper, middle, lower, percentB, bandwidth }}
 *          Each key is an array of (number|null) aligned to `closes`.
 */
import { SMA } from './SMA.js';

export function BB(closes, period = 20, mult = 2) {
  const middle = SMA(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  const percentB = new Array(closes.length).fill(null);
  const bandwidth = new Array(closes.length).fill(null);

  for (let i = period - 1; i < closes.length; i++) {
    if (middle[i] == null) continue;
    const window = closes.slice(i - period + 1, i + 1);
    const mean = middle[i];
    const variance = window.reduce((acc, v) => acc + (v - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);

    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;

    const bw = upper[i] - lower[i];
    percentB[i] = bw > 0 ? (closes[i] - lower[i]) / bw : 0.5;
    bandwidth[i] = mean > 0 ? bw / mean : 0;
  }

  return { upper, middle, lower, percentB, bandwidth };
}

export default BB;

/**
 * SFTi.CIPs/EMA.js — Exponential Moving Average
 *
 * Computes EMA using the standard Wilder multiplier:
 *   multiplier = 2 / (period + 1)
 *   EMA[i]     = close[i] × multiplier + EMA[i-1] × (1 - multiplier)
 *
 * Seeds with an SMA over the first `period` values for accuracy.
 *
 * @param {number[]} closes  Closing prices (oldest first)
 * @param {number}   period
 * @returns {(number|null)[]}
 */
export function EMA(closes, period) {
  if (!closes || closes.length < period) return closes.map(() => null);
  const k = 2 / (period + 1);
  const out = new Array(closes.length).fill(null);

  // Seed with SMA
  let seed = 0;
  for (let i = 0; i < period; i++) seed += closes[i];
  out[period - 1] = seed / period;

  for (let i = period; i < closes.length; i++) {
    out[i] = closes[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

export default EMA;

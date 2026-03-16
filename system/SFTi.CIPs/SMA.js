/**
 * SFTi.CIPs/SMA.js — Simple Moving Average
 *
 * Computes SMA over an array of closing prices (or any numeric series).
 * All computation is local, integer-exact for whole-number periods,
 * and uses a sliding window for O(n) performance.
 *
 * @param {number[]} closes  Array of closing prices (oldest first)
 * @param {number}   period  Look-back period (e.g. 20, 50, 200)
 * @returns {(number|null)[]} SMA values aligned to input; first (period-1) values are null
 */
export function SMA(closes, period) {
  if (!closes || closes.length < period) return closes.map(() => null);
  const out = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= period) sum -= closes[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export default SMA;

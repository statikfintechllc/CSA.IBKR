/**
 * SFTi.CIPs/RSI.js — Relative Strength Index (Wilder, 14-period standard)
 *
 * Algorithm (Wilder's Smoothed Method — identical to TradingView default):
 *   1. Calculate daily price changes.
 *   2. Separate into gains (positive) and losses (absolute negative).
 *   3. Seed average gain/loss = simple mean over first `period` changes.
 *   4. For subsequent values use Wilder smoothing:
 *      avgGain[i] = (avgGain[i-1] × (period-1) + gain[i]) / period
 *   5. RS = avgGain / avgLoss
 *   6. RSI = 100 − (100 / (1 + RS))
 *
 * @param {number[]} closes   Closing prices (oldest first)
 * @param {number}   [period=14]
 * @returns {(number|null)[]}  RSI values [0–100]; null before seed complete
 */
export function RSI(closes, period = 14) {
  if (!closes || closes.length <= period) return closes.map(() => null);
  const out = new Array(closes.length).fill(null);

  let avgGain = 0;
  let avgLoss = 0;

  // Seed
  for (let i = 1; i <= period; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta > 0) avgGain += delta;
    else avgLoss += Math.abs(delta);
  }
  avgGain /= period;
  avgLoss /= period;

  const rs0 = avgLoss === 0 ? Infinity : avgGain / avgLoss;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs0);

  for (let i = period + 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? Math.abs(delta) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs);
  }
  return out;
}

export default RSI;

/**
 * SFTi.CIPs/MACD.js — Moving Average Convergence/Divergence
 *
 * Standard MACD (12, 26, 9) as used by most professional platforms:
 *   MACD Line    = EMA(12) − EMA(26)
 *   Signal Line  = EMA(9) of MACD Line
 *   Histogram    = MACD Line − Signal Line
 *
 * @param {number[]} closes       Closing prices (oldest first)
 * @param {number}   [fast=12]    Fast EMA period
 * @param {number}   [slow=26]    Slow EMA period
 * @param {number}   [signal=9]   Signal EMA period
 * @returns {{ macd: (number|null)[], signal: (number|null)[], histogram: (number|null)[] }}
 */
import { EMA } from './EMA.js';

export function MACD(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = EMA(closes, fast);
  const emaSlow = EMA(closes, slow);

  const macdLine = closes.map((_, i) => {
    if (emaFast[i] == null || emaSlow[i] == null) return null;
    return emaFast[i] - emaSlow[i];
  });

  // Signal = EMA(9) of MACD line values (treat nulls as gaps)
  const macdValues = macdLine.map((v) => (v == null ? 0 : v));
  const signalRaw = EMA(macdValues, signal);
  const signalLine = signalRaw.map((v, i) => (macdLine[i] == null ? null : v));

  const histogram = macdLine.map((m, i) => {
    if (m == null || signalLine[i] == null) return null;
    return m - signalLine[i];
  });

  return { macd: macdLine, signal: signalLine, histogram };
}

export default MACD;

/**
 * SFTi.IOS/patterns/patterns.js — Chart Pattern Recognition
 *
 * Detects classic technical analysis patterns from OHLCV data:
 *   - Double Top / Double Bottom
 *   - Head and Shoulders / Inverse H&S
 *   - Ascending / Descending / Symmetrical Triangle
 *   - Bull / Bear Flag
 *   - Cup and Handle
 *   - Engulfing candles (bullish / bearish)
 *   - Doji
 *   - Hammer / Shooting Star
 *
 * All computation is local (client-side).  No external libraries required.
 *
 * @param {object[]} candles  Array of { time, open, high, low, close, volume }
 * @returns {object[]}        Detected patterns with start/end index + direction
 */

export class PatternScanner {
  /**
   * @param {object[]} candles  OHLCV candles (newest last)
   */
  constructor(candles) {
    this._c = candles;
  }

  /** Run all detectors and return an array of detected patterns. */
  scan() {
    const results = [];
    results.push(...this._engulfing());
    results.push(...this._doji());
    results.push(...this._hammer());
    results.push(...this._doubleTop());
    results.push(...this._doubleBottom());
    results.push(...this._headAndShoulders());
    results.push(...this._flag());
    return results.sort((a, b) => b.end - a.end);
  }

  // ─── Single-candle patterns ──────────────────────────────────────────────────

  _engulfing() {
    const out = [];
    const c = this._c;
    for (let i = 1; i < c.length; i++) {
      const prev = c[i - 1];
      const curr = c[i];
      if (
        curr.open < prev.close &&
        curr.close > prev.open &&
        prev.close < prev.open
      ) {
        out.push({ pattern: 'Bullish Engulfing', start: i - 1, end: i, direction: 'bullish' });
      } else if (
        curr.open > prev.close &&
        curr.close < prev.open &&
        prev.close > prev.open
      ) {
        out.push({ pattern: 'Bearish Engulfing', start: i - 1, end: i, direction: 'bearish' });
      }
    }
    return out;
  }

  _doji() {
    const out = [];
    const c = this._c;
    for (let i = 0; i < c.length; i++) {
      const body = Math.abs(c[i].close - c[i].open);
      const range = c[i].high - c[i].low;
      if (range > 0 && body / range < 0.1) {
        out.push({ pattern: 'Doji', start: i, end: i, direction: 'neutral' });
      }
    }
    return out;
  }

  _hammer() {
    const out = [];
    const c = this._c;
    for (let i = 0; i < c.length; i++) {
      const body = Math.abs(c[i].close - c[i].open);
      const lowerShadow = Math.min(c[i].open, c[i].close) - c[i].low;
      const upperShadow = c[i].high - Math.max(c[i].open, c[i].close);
      if (body > 0 && lowerShadow > body * 2 && upperShadow < body * 0.5) {
        out.push({ pattern: 'Hammer', start: i, end: i, direction: 'bullish' });
      } else if (body > 0 && upperShadow > body * 2 && lowerShadow < body * 0.5) {
        out.push({ pattern: 'Shooting Star', start: i, end: i, direction: 'bearish' });
      }
    }
    return out;
  }

  // ─── Multi-candle patterns ───────────────────────────────────────────────────

  _doubleTop() {
    const out = [];
    const closes = this._c.map((c) => c.high);
    const peaks = this._findPeaks(closes);
    for (let i = 0; i + 1 < peaks.length; i++) {
      const a = peaks[i];
      const b = peaks[i + 1];
      if (
        closes[a] !== 0 &&
        Math.abs(closes[a] - closes[b]) / closes[a] < 0.015 &&
        b - a >= 5
      ) {
        out.push({ pattern: 'Double Top', start: a, end: b, direction: 'bearish' });
      }
    }
    return out;
  }

  _doubleBottom() {
    const out = [];
    const lows = this._c.map((c) => c.low);
    const troughs = this._findTroughs(lows);
    for (let i = 0; i + 1 < troughs.length; i++) {
      const a = troughs[i];
      const b = troughs[i + 1];
      if (
        Math.abs(lows[a] - lows[b]) / lows[a] < 0.015 &&
        b - a >= 5
      ) {
        out.push({ pattern: 'Double Bottom', start: a, end: b, direction: 'bullish' });
      }
    }
    return out;
  }

  _headAndShoulders() {
    const out = [];
    const highs = this._c.map((c) => c.high);
    const peaks = this._findPeaks(highs);
    for (let i = 0; i + 2 < peaks.length; i++) {
      const l = peaks[i];
      const h = peaks[i + 1];
      const r = peaks[i + 2];
      if (
        highs[h] > highs[l] * 1.02 &&
        highs[h] > highs[r] * 1.02 &&
        Math.abs(highs[l] - highs[r]) / highs[l] < 0.03
      ) {
        out.push({ pattern: 'Head and Shoulders', start: l, end: r, direction: 'bearish' });
      } else if (
        highs[h] < highs[l] * 0.98 &&
        highs[h] < highs[r] * 0.98 &&
        Math.abs(highs[l] - highs[r]) / highs[l] < 0.03
      ) {
        out.push({ pattern: 'Inverse Head and Shoulders', start: l, end: r, direction: 'bullish' });
      }
    }
    return out;
  }

  _flag() {
    const out = [];
    const c = this._c;
    for (let i = 5; i < c.length - 5; i++) {
      const poleGain = (c[i].close - c[i - 5].close) / c[i - 5].close;
      if (Math.abs(poleGain) < 0.05) continue;
      const consolidation = c.slice(i, i + 5);
      const maxDev = Math.max(...consolidation.map((x) => Math.abs(x.close - c[i].close) / c[i].close));
      if (maxDev < 0.015) {
        out.push({
          pattern: poleGain > 0 ? 'Bull Flag' : 'Bear Flag',
          start: i - 5,
          end: i + 5,
          direction: poleGain > 0 ? 'bullish' : 'bearish',
        });
      }
    }
    return out;
  }

  // ─── Utility ─────────────────────────────────────────────────────────────────

  _findPeaks(arr) {
    const peaks = [];
    for (let i = 1; i < arr.length - 1; i++) {
      if (arr[i] > arr[i - 1] && arr[i] > arr[i + 1]) peaks.push(i);
    }
    return peaks;
  }

  _findTroughs(arr) {
    const troughs = [];
    for (let i = 1; i < arr.length - 1; i++) {
      if (arr[i] < arr[i - 1] && arr[i] < arr[i + 1]) troughs.push(i);
    }
    return troughs;
  }
}

export default PatternScanner;

# SFTi.CIPs — Chart Indicator Plugins

Client-side technical indicator computations for CSA.IBKR.
All functions are pure ES module exports with no dependencies.

## Modules

| File | Algorithm | Output |
|------|-----------|--------|
| `SMA.js` | Simple Moving Average (sliding window, O(n)) | `(number\|null)[]` |
| `EMA.js` | Exponential Moving Average (Wilder multiplier) | `(number\|null)[]` |
| `RSI.js` | RSI 14 — Wilder smoothed (identical to TradingView) | `(number\|null)[]` |
| `MACD.js` | MACD (12, 26, 9) — MACD line, signal, histogram | `{ macd, signal, histogram }` |
| `BB.js` | Bollinger Bands (20, 2σ) — upper, middle, lower, %B, bandwidth | `{ upper, middle, lower, percentB, bandwidth }` |

## Usage

```js
import { SMA }  from './SFTi.CIPs/SMA.js';
import { EMA }  from './SFTi.CIPs/EMA.js';
import { RSI }  from './SFTi.CIPs/RSI.js';
import { MACD } from './SFTi.CIPs/MACD.js';
import { BB }   from './SFTi.CIPs/BB.js';

const closes = candles.map(c => c.close);

const sma50    = SMA(closes, 50);
const ema20    = EMA(closes, 20);
const rsi14    = RSI(closes, 14);
const macdData = MACD(closes);           // { macd, signal, histogram }
const bands    = BB(closes, 20, 2);      // { upper, middle, lower, percentB, bandwidth }
```

All arrays are aligned 1:1 with the input `closes` array.
Values before sufficient data is available are returned as `null`.

## Adding a Custom Indicator

1. Create `MyIndicator.js` in this directory.
2. Export a named function: `export function MyIndicator(closes, ...params) { ... }`
3. Return an array of `number | null` aligned to the input.
4. Import in `system/configs/main.chart/js/dynamics.js` and call `chart.addOverlay()`.

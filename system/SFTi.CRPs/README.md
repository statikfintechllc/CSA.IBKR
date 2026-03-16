# SFTi.CRPs — Chart Rendering Plugins

State-of-the-art Canvas 2D chart renderers for CSA.IBKR.
All charts are self-contained ES modules with zero runtime dependencies.

## Modules

| File | Description |
|------|-------------|
| `LineChart.js` | Smooth cubic-spline line / gradient area chart |
| `CandleChart.js` | OHLCV candlestick chart with volume sub-panel and sub-panel indicators |
| `VolumeChart.js` | Standalone volume bar chart |

## Features

- **HiDPI** — automatic `devicePixelRatio` scaling for Retina / Super Retina displays
- **Touch** — pinch-to-zoom + swipe-to-pan on iPhone/iPad
- **Mouse** — wheel-zoom + crosshair tooltip on desktop
- **Overlays** — price-level indicator lines from `SFTi.CIPs`
- **Sub-panels** — oscillators (RSI, MACD histogram) rendered beneath the main chart
- **Live data** — `appendPoint()` API for streaming real-time candles
- **Responsive** — `ResizeObserver` re-renders on container resize

## Usage

```js
import { CandleChart } from './SFTi.CRPs/CandleChart.js';
import { EMA } from './SFTi.CIPs/EMA.js';
import { RSI } from './SFTi.CIPs/RSI.js';

const chart = new CandleChart(canvasEl, { upColor: '#26a69a', downColor: '#ef5350' });
chart.setData(candles);    // [{time, open, high, low, close, volume}]

const closes = candles.map(c => c.close);
chart.addOverlay(EMA(closes, 20), { color: '#00d4ff', label: 'EMA 20' });

const rsi = RSI(closes, 14);
chart.addSubPanel({ data: rsi, label: 'RSI 14', color: '#f59e0b', range: [0, 100], refLines: [70, 30] });
```

## Adding a Custom Chart Plugin

1. Create `MyChart.js` in this directory.
2. Export a class with `setData(data)` and `render()` methods.
3. Add to `sw.js` STATIC_ASSETS precache list.
4. Import in `system/configs/main.chart/js/dynamics.js`.

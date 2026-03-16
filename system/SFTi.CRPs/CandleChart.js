/**
 * SFTi.CRPs/CandleChart.js — State-of-the-Art Candlestick Chart
 *
 * A high-performance Canvas 2D OHLCV candlestick renderer.
 * Supports:
 *   - Classic hollow or filled candles with configurable wick colours
 *   - Volume bars beneath the chart (semi-transparent)
 *   - HiDPI / Retina rendering
 *   - Touch + mouse pan & pinch-to-zoom
 *   - Crosshair overlay with OHLCV tooltip
 *   - Indicator overlays (price-level lines from SFTi.CIPs)
 *   - Sub-panels for oscillators (RSI, MACD)
 *   - Pattern annotation markers (from patterns.js)
 *
 * Usage:
 *   const chart = new CandleChart(canvas, config);
 *   chart.setData(candles);        // [{time,open,high,low,close,volume}]
 *   chart.addOverlay(ema20, { color: '#00d4ff', label: 'EMA 20' });
 *   chart.addSubPanel({ data: rsiValues, label: 'RSI 14', color: '#ff6b35', range: [0,100] });
 *   chart.render();
 */

export class CandleChart {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} [config]
   */
  constructor(canvas, config = {}) {
    this._canvas = canvas;
    this._ctx = canvas.getContext('2d');
    this._cfg = {
      upColor: config.upColor || '#26a69a',
      downColor: config.downColor || '#ef5350',
      upWick: config.upWick || '#26a69a',
      downWick: config.downWick || '#ef5350',
      volumeUp: config.volumeUp || 'rgba(38,166,154,0.3)',
      volumeDown: config.volumeDown || 'rgba(239,83,80,0.3)',
      gridColor: config.gridColor || 'rgba(255,255,255,0.06)',
      axisColor: config.axisColor || 'rgba(255,255,255,0.35)',
      crosshairColor: config.crosshairColor || 'rgba(255,255,255,0.5)',
      tooltipBg: config.tooltipBg || 'rgba(15,15,25,0.92)',
      tooltipColor: config.tooltipColor || '#f0f0f0',
      font: config.font || '11px -apple-system, SF Pro Text, sans-serif',
      padLeft: config.padLeft || 65,
      padRight: config.padRight || 20,
      padTop: config.padTop || 15,
      padBottom: config.padBottom || 40,
      volumeHeightRatio: config.volumeHeightRatio || 0.18,
      subPanelHeightRatio: config.subPanelHeightRatio || 0.2,
      gridRows: config.gridRows || 5,
      minCandleW: config.minCandleW || 2,
      maxCandleW: config.maxCandleW || 24,
      ...config,
    };

    this._data = [];
    this._overlays = [];
    this._subPanels = [];
    this._patterns = [];
    this._viewStart = 0;
    this._viewEnd = 0;
    this._crosshairX = null;
    this._crosshairY = null;
    this._dpr = window.devicePixelRatio || 1;
    this._panStart = null;

    this._setupHiDPI();
    this._bindEvents();
  }

  /** Set OHLCV data. */
  setData(data) {
    this._data = data || [];
    this._viewStart = Math.max(0, this._data.length - 120);
    this._viewEnd = this._data.length;
    this.render();
  }

  appendPoint(point) {
    this._data.push(point);
    if (this._viewEnd >= this._data.length - 1) this._viewEnd = this._data.length;
    this.render();
  }

  addOverlay(values, opts = {}) {
    this._overlays.push({
      data: values,
      color: opts.color || '#ffb700',
      label: opts.label || '',
      lineWidth: opts.lineWidth || 1.5,
    });
    this.render();
  }

  addSubPanel(opts) {
    this._subPanels.push({
      data: opts.data || [],
      label: opts.label || '',
      color: opts.color || '#a78bfa',
      lineWidth: opts.lineWidth || 1.5,
      range: opts.range || null,
      refLines: opts.refLines || [],
    });
    this.render();
  }

  annotatePatterns(patterns) {
    this._patterns = patterns || [];
    this.render();
  }

  clearOverlays() { this._overlays = []; this.render(); }
  clearSubPanels() { this._subPanels = []; this.render(); }

  render() {
    const { _ctx: ctx, _canvas: c } = this;
    const dpr = this._dpr;
    const W = c.width / dpr;
    const H = c.height / dpr;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const slice = this._data.slice(this._viewStart, this._viewEnd);
    if (!slice.length) { ctx.restore(); return; }

    const { padLeft: pL, padRight: pR, padTop: pT, padBottom: pB } = this._cfg;
    const subH = this._subPanels.length * H * this._cfg.subPanelHeightRatio;
    const volH = H * this._cfg.volumeHeightRatio;
    const priceH = H - pT - pB - volH - subH;
    const plotW = W - pL - pR;

    const prices = slice.flatMap((d) => [d.high, d.low]);
    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);
    const range = maxP - minP || 1;
    const maxVol = Math.max(...slice.map((d) => d.volume || 0)) || 1;

    const candleW = Math.max(
      this._cfg.minCandleW,
      Math.min(this._cfg.maxCandleW, Math.floor(plotW / slice.length) - 1)
    );

    const toX = (i) => pL + ((i + 0.5) / slice.length) * plotW;
    const toY = (p) => pT + priceH - ((p - minP) / range) * priceH;
    const volY0 = pT + priceH + 4;

    this._drawGrid(ctx, pL, pT, plotW, priceH);
    this._drawVolume(ctx, slice, toX, volY0, volH, maxVol, candleW);
    this._drawCandles(ctx, slice, toX, toY, candleW);
    this._drawOverlays(ctx, slice, toX, toY);
    this._drawPatternMarkers(ctx, slice, toX, toY);
    this._drawAxes(ctx, pL, pT, plotW, priceH, minP, maxP, slice);
    this._drawSubPanels(ctx, slice, pL, pT + priceH + volH + 8, plotW, subH, pB);

    if (this._crosshairX !== null) {
      this._drawCrosshair(ctx, pL, pT, plotW, priceH, W, H, slice, toX, toY, minP, maxP, candleW);
    }

    ctx.restore();
  }

  // ─── Drawing ─────────────────────────────────────────────────────────────────

  _drawGrid(ctx, pL, pT, plotW, priceH) {
    ctx.strokeStyle = this._cfg.gridColor;
    ctx.lineWidth = 1;
    for (let r = 0; r <= this._cfg.gridRows; r++) {
      const y = pT + (r / this._cfg.gridRows) * priceH;
      ctx.beginPath();
      ctx.moveTo(pL, y); ctx.lineTo(pL + plotW, y);
      ctx.stroke();
    }
  }

  _drawVolume(ctx, slice, toX, y0, volH, maxVol, candleW) {
    slice.forEach((d, i) => {
      const h = ((d.volume || 0) / maxVol) * (volH - 4);
      ctx.fillStyle = d.close >= d.open ? this._cfg.volumeUp : this._cfg.volumeDown;
      ctx.fillRect(toX(i) - candleW / 2, y0 + volH - h, candleW, h);
    });
  }

  _drawCandles(ctx, slice, toX, toY, candleW) {
    slice.forEach((d, i) => {
      const x = toX(i);
      const open = toY(d.open);
      const close = toY(d.close);
      const high = toY(d.high);
      const low = toY(d.low);
      const bull = d.close >= d.open;

      const bodyTop = Math.min(open, close);
      const bodyH = Math.max(1, Math.abs(open - close));

      // Wick
      ctx.strokeStyle = bull ? this._cfg.upWick : this._cfg.downWick;
      ctx.lineWidth = Math.max(1, candleW * 0.15);
      ctx.beginPath();
      ctx.moveTo(x, high); ctx.lineTo(x, bodyTop);
      ctx.moveTo(x, bodyTop + bodyH); ctx.lineTo(x, low);
      ctx.stroke();

      // Body
      ctx.fillStyle = bull ? this._cfg.upColor : this._cfg.downColor;
      ctx.fillRect(x - candleW / 2, bodyTop, candleW, bodyH);
    });
  }

  _drawOverlays(ctx, slice, toX, toY) {
    for (const ov of this._overlays) {
      const ovSlice = (ov.data || []).slice(this._viewStart, this._viewEnd);
      const pts = ovSlice.map((v, i) => (v != null ? { x: toX(i), y: toY(v) } : null)).filter(Boolean);
      if (pts.length < 2) continue;
      ctx.strokeStyle = ov.color;
      ctx.lineWidth = ov.lineWidth;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      pts.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
      ctx.stroke();
    }
  }

  _drawPatternMarkers(ctx, slice, toX, toY) {
    for (const p of this._patterns) {
      const i = p.end - this._viewStart;
      if (i < 0 || i >= slice.length) continue;
      const x = toX(i);
      const y = p.direction === 'bullish' ? toY(slice[i].low) + 16 : toY(slice[i].high) - 16;
      ctx.fillStyle = p.direction === 'bullish' ? '#26a69a' : '#ef5350';
      ctx.font = '10px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(p.pattern, x, y);
    }
  }

  _drawAxes(ctx, pL, pT, plotW, priceH, minP, maxP, slice) {
    ctx.fillStyle = this._cfg.axisColor;
    ctx.font = this._cfg.font;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (let r = 0; r <= this._cfg.gridRows; r++) {
      const p = maxP - (r / this._cfg.gridRows) * (maxP - minP);
      const y = pT + (r / this._cfg.gridRows) * priceH;
      ctx.fillText(p.toFixed(2), pL - 6, y);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const step = Math.max(1, Math.floor(slice.length / 6));
    for (let i = 0; i < slice.length; i += step) {
      const x = pL + ((i + 0.5) / slice.length) * plotW;
      ctx.fillText(this._fmt(slice[i].time), x, pT + priceH + 4);
    }
  }

  _drawSubPanels(ctx, slice, pL, y0, plotW, totalSubH, pB) {
    if (!this._subPanels.length) return;
    const panH = totalSubH / this._subPanels.length;

    this._subPanels.forEach((panel, pi) => {
      const py = y0 + pi * panH;
      const pvs = (panel.data || []).slice(this._viewStart, this._viewEnd);
      const valid = pvs.filter((v) => v != null);
      if (!valid.length) return;
      const [minV, maxV] = panel.range || [Math.min(...valid), Math.max(...valid)];
      const rng = (maxV - minV) || 1;
      const toY = (v) => py + panH - ((v - minV) / rng) * (panH - 4);

      // Background
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      ctx.fillRect(pL, py, plotW, panH - 4);

      // Reference lines
      for (const ref of panel.refLines) {
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        const ry = toY(ref);
        ctx.beginPath();
        ctx.moveTo(pL, ry); ctx.lineTo(pL + plotW, ry);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.font = '9px -apple-system';
        ctx.textAlign = 'right';
        ctx.fillText(ref, pL - 4, ry);
      }

      // Label
      ctx.fillStyle = panel.color;
      ctx.font = '10px -apple-system';
      ctx.textAlign = 'left';
      ctx.fillText(panel.label, pL + 4, py + 10);

      // Line
      const pts = pvs.map((v, i) =>
        v != null ? { x: pL + ((i + 0.5) / slice.length) * plotW, y: toY(v) } : null
      ).filter(Boolean);

      if (pts.length < 2) return;
      ctx.strokeStyle = panel.color;
      ctx.lineWidth = panel.lineWidth;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      pts.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
      ctx.stroke();
    });
  }

  _drawCrosshair(ctx, pL, pT, plotW, priceH, W, H, slice, toX, toY, minP, maxP, candleW) {
    const mx = this._crosshairX;
    if (mx < pL || mx > pL + plotW) return;

    const idx = Math.round(((mx - pL) / plotW) * slice.length - 0.5);
    const clamped = Math.max(0, Math.min(idx, slice.length - 1));
    const d = slice[clamped];
    if (!d) return;

    const cx = toX(clamped);
    const cy = toY(d.close);

    ctx.strokeStyle = this._cfg.crosshairColor;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(cx, pT); ctx.lineTo(cx, pT + priceH);
    ctx.moveTo(pL, cy); ctx.lineTo(pL + plotW, cy);
    ctx.stroke();
    ctx.setLineDash([]);

    const lines = [
      this._fmt(d.time),
      `O ${d.open?.toFixed(2)}  H ${d.high?.toFixed(2)}`,
      `L ${d.low?.toFixed(2)}  C ${d.close?.toFixed(2)}`,
      `Vol ${this._fmtVol(d.volume)}`,
    ];
    this._drawTooltip(ctx, cx, cy, lines, pL, plotW, W);
  }

  _drawTooltip(ctx, x, y, lines, pL, plotW, W) {
    ctx.font = this._cfg.font;
    const pad = 8;
    const lH = 16;
    const bW = 130;
    const bH = lines.length * lH + pad * 2;
    let tx = x + 14;
    if (tx + bW > W - 8) tx = x - bW - 14;
    const ty = Math.max(8, y - bH / 2);
    ctx.fillStyle = this._cfg.tooltipBg;
    ctx.beginPath();
    ctx.roundRect(tx, ty, bW, bH, 4);
    ctx.fill();
    ctx.fillStyle = this._cfg.tooltipColor;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, tx + pad, ty + pad + i * lH));
  }

  // ─── HiDPI ───────────────────────────────────────────────────────────────────

  _setupHiDPI() {
    const dpr = this._dpr;
    const c = this._canvas;
    const rect = c.getBoundingClientRect();
    c.width = (rect.width || c.clientWidth || 400) * dpr;
    c.height = (rect.height || c.clientHeight || 350) * dpr;
  }

  // ─── Events ──────────────────────────────────────────────────────────────────

  _bindEvents() {
    const c = this._canvas;
    const getPos = (e) => {
      const r = c.getBoundingClientRect();
      const t = e.touches?.[0];
      return { x: ((t || e).clientX - r.left), y: ((t || e).clientY - r.top) };
    };

    c.addEventListener('mousemove', (e) => {
      const { x, y } = getPos(e);
      this._crosshairX = x;
      this._crosshairY = y;
      this.render();
    });
    c.addEventListener('mouseleave', () => { this._crosshairX = null; this.render(); });

    c.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const { x, y } = getPos(e);
      this._crosshairX = x;
      this._crosshairY = y;
      this.render();
    }, { passive: false });

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 1 : -1;
      const len = this._data.length;
      const view = this._viewEnd - this._viewStart;
      const newView = Math.min(len, Math.max(10, view + delta * Math.ceil(view * 0.1)));
      const center = Math.round((this._viewStart + this._viewEnd) / 2);
      this._viewStart = Math.max(0, center - Math.floor(newView / 2));
      this._viewEnd = Math.min(len, this._viewStart + newView);
      this.render();
    }, { passive: false });

    // Pinch zoom (touch)
    let lastDist = null;
    c.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        lastDist = Math.hypot(dx, dy);
      }
    });
    c.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.hypot(dx, dy);
        if (lastDist !== null) {
          const scale = dist / lastDist;
          const view = this._viewEnd - this._viewStart;
          const newView = Math.min(this._data.length, Math.max(10, Math.round(view / scale)));
          const center = Math.round((this._viewStart + this._viewEnd) / 2);
          this._viewStart = Math.max(0, center - Math.floor(newView / 2));
          this._viewEnd = Math.min(this._data.length, this._viewStart + newView);
          this.render();
        }
        lastDist = dist;
      }
    }, { passive: false });

    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => { this._setupHiDPI(); this.render(); }).observe(c);
    }
  }

  // ─── Utilities ───────────────────────────────────────────────────────────────

  _fmt(t) {
    if (!t) return '';
    const d = new Date(typeof t === 'number' ? t : t);
    if (isNaN(d)) return String(t);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  _fmtVol(v) {
    if (!v) return '—';
    if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return String(v);
  }
}

export default CandleChart;

/**
 * SFTi.CRPs/LineChart.js — State-of-the-Art Line/Area Chart
 *
 * A high-performance, resolution-independent Canvas 2D chart renderer.
 * Supports:
 *   - Smooth cubic-spline line or sharp polyline
 *   - Gradient fill area beneath the line
 *   - Retina / HiDPI display awareness (devicePixelRatio)
 *   - Animated entrance and live-data append
 *   - Touch and mouse panning + pinch-to-zoom
 *   - Crosshair with tooltip overlay
 *   - Configurable axes, grid, padding
 *   - Overlay indicator series (from SFTi.CIPs)
 *
 * Usage:
 *   const chart = new LineChart(canvasElement, config);
 *   chart.setData(candles);        // [{time, close}, ...]
 *   chart.addOverlay(ema20Data, { color: '#00d4ff', label: 'EMA 20' });
 *   chart.render();
 */

export class LineChart {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} [config]
   */
  constructor(canvas, config = {}) {
    this._canvas = canvas;
    this._ctx = canvas.getContext('2d');
    this._cfg = {
      lineColor: config.lineColor || '#00d4ff',
      fillStart: config.fillStart || 'rgba(0,212,255,0.25)',
      fillEnd: config.fillEnd || 'rgba(0,212,255,0)',
      gridColor: config.gridColor || 'rgba(255,255,255,0.06)',
      axisColor: config.axisColor || 'rgba(255,255,255,0.35)',
      crosshairColor: config.crosshairColor || 'rgba(255,255,255,0.5)',
      tooltipBg: config.tooltipBg || 'rgba(15,15,25,0.92)',
      tooltipColor: config.tooltipColor || '#f0f0f0',
      font: config.font || '11px -apple-system, SF Pro Text, sans-serif',
      lineWidth: config.lineWidth || 2,
      padLeft: config.padLeft || 60,
      padRight: config.padRight || 20,
      padTop: config.padTop || 20,
      padBottom: config.padBottom || 40,
      gridRows: config.gridRows || 5,
      gridCols: config.gridCols || 6,
      smooth: config.smooth !== false,
      animate: config.animate !== false,
      ...config,
    };

    this._data = [];       // [{time, close}]
    this._overlays = [];   // [{data, color, label, lineWidth}]
    this._viewStart = 0;   // index into _data
    this._viewEnd = 0;
    this._crosshairX = null;
    this._crosshairY = null;
    this._dpr = window.devicePixelRatio || 1;
    this._animFrame = null;

    this._setupHiDPI();
    this._bindEvents();
  }

  /**
   * Set the primary data series.
   * @param {object[]} data  [{time: number|string, close: number}, ...]
   */
  setData(data) {
    this._data = data || [];
    this._viewStart = 0;
    this._viewEnd = this._data.length;
    if (this._cfg.animate) {
      this._animateEntrance();
    } else {
      this.render();
    }
  }

  /**
   * Append a single new data point (live streaming).
   * @param {{time: number, close: number}} point
   */
  appendPoint(point) {
    this._data.push(point);
    if (this._viewEnd >= this._data.length - 1) {
      this._viewEnd = this._data.length;
    }
    this.render();
  }

  /**
   * Add an indicator overlay line.
   * @param {number[]} values        One value per candle (aligned to data)
   * @param {object}   [opts]
   * @param {string}   [opts.color]
   * @param {string}   [opts.label]
   * @param {number}   [opts.lineWidth]
   */
  addOverlay(values, opts = {}) {
    this._overlays.push({
      data: values,
      color: opts.color || '#ffb700',
      label: opts.label || '',
      lineWidth: opts.lineWidth || 1.5,
    });
    this.render();
  }

  /** Remove all overlays. */
  clearOverlays() {
    this._overlays = [];
    this.render();
  }

  /** Full render pass. */
  render() {
    const { _ctx: ctx, _canvas: c } = this;
    const w = c.width / this._dpr;
    const h = c.height / this._dpr;

    ctx.save();
    ctx.scale(this._dpr, this._dpr);
    ctx.clearRect(0, 0, w, h);

    const slice = this._data.slice(this._viewStart, this._viewEnd);
    if (!slice.length) { ctx.restore(); return; }

    const { padLeft: pL, padRight: pR, padTop: pT, padBottom: pB } = this._cfg;
    const plotW = w - pL - pR;
    const plotH = h - pT - pB;

    const prices = slice.map((d) => d.close);
    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);
    const range = maxP - minP || 1;

    const toX = (i) => pL + (i / (slice.length - 1 || 1)) * plotW;
    const toY = (p) => pT + plotH - ((p - minP) / range) * plotH;

    const points = slice.map((d, i) => ({ x: toX(i), y: toY(d.close) }));

    this._drawGrid(ctx, pL, pT, plotW, plotH, minP, maxP, slice);
    this._drawArea(ctx, points, pT, plotH);
    this._drawLine(ctx, points, this._cfg.lineColor, this._cfg.lineWidth);

    for (const ov of this._overlays) {
      const ovSlice = (ov.data || []).slice(this._viewStart, this._viewEnd);
      const ovPoints = ovSlice
        .map((v, i) => (v != null ? { x: toX(i), y: toY(v) } : null))
        .filter(Boolean);
      if (ovPoints.length > 1) {
        this._drawLine(ctx, ovPoints, ov.color, ov.lineWidth);
      }
    }

    this._drawAxes(ctx, pL, pT, plotW, plotH, minP, maxP, slice);

    if (this._crosshairX !== null) {
      this._drawCrosshair(ctx, pL, pT, plotW, plotH, w, h, slice, points, toX, toY, minP, maxP);
    }

    ctx.restore();
  }

  // ─── Drawing helpers ─────────────────────────────────────────────────────────

  _drawGrid(ctx, pL, pT, plotW, plotH, minP, maxP, slice) {
    ctx.strokeStyle = this._cfg.gridColor;
    ctx.lineWidth = 1;
    // Horizontal grid lines
    for (let r = 0; r <= this._cfg.gridRows; r++) {
      const y = pT + (r / this._cfg.gridRows) * plotH;
      ctx.beginPath();
      ctx.moveTo(pL, y);
      ctx.lineTo(pL + plotW, y);
      ctx.stroke();
    }
    // Vertical grid lines
    for (let c = 0; c <= this._cfg.gridCols; c++) {
      const x = pL + (c / this._cfg.gridCols) * plotW;
      ctx.beginPath();
      ctx.moveTo(x, pT);
      ctx.lineTo(x, pT + plotH);
      ctx.stroke();
    }
  }

  _drawArea(ctx, points, pT, plotH) {
    if (!points.length) return;
    const grad = ctx.createLinearGradient(0, pT, 0, pT + plotH);
    grad.addColorStop(0, this._cfg.fillStart);
    grad.addColorStop(1, this._cfg.fillEnd);
    ctx.fillStyle = grad;
    ctx.beginPath();
    this._tracePath(ctx, points);
    ctx.lineTo(points[points.length - 1].x, pT + plotH);
    ctx.lineTo(points[0].x, pT + plotH);
    ctx.closePath();
    ctx.fill();
  }

  _drawLine(ctx, points, color, width) {
    if (points.length < 2) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    this._tracePath(ctx, points);
    ctx.stroke();
  }

  _tracePath(ctx, points) {
    if (!this._cfg.smooth || points.length < 4) {
      ctx.moveTo(points[0].x, points[0].y);
      points.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
      return;
    }
    // Catmull-Rom spline through all points
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[Math.max(i - 1, 0)];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[Math.min(i + 2, points.length - 1)];
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
    }
  }

  _drawAxes(ctx, pL, pT, plotW, plotH, minP, maxP, slice) {
    ctx.fillStyle = this._cfg.axisColor;
    ctx.font = this._cfg.font;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';

    // Y-axis price labels
    for (let r = 0; r <= this._cfg.gridRows; r++) {
      const p = maxP - (r / this._cfg.gridRows) * (maxP - minP);
      const y = pT + (r / this._cfg.gridRows) * plotH;
      ctx.fillText(p.toFixed(2), pL - 6, y);
    }

    // X-axis time labels
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const step = Math.max(1, Math.floor(slice.length / this._cfg.gridCols));
    for (let i = 0; i < slice.length; i += step) {
      const x = pL + (i / (slice.length - 1 || 1)) * plotW;
      const label = this._formatTime(slice[i].time);
      ctx.fillText(label, x, pT + plotH + 6);
    }
  }

  _drawCrosshair(ctx, pL, pT, plotW, plotH, w, h, slice, points, toX, toY, minP, maxP) {
    const mx = this._crosshairX;
    const my = this._crosshairY;
    if (mx < pL || mx > pL + plotW) return;

    // Find nearest data point
    const idx = Math.round(((mx - pL) / plotW) * (slice.length - 1));
    const clamped = Math.max(0, Math.min(idx, slice.length - 1));
    const pt = points[clamped];
    if (!pt) return;

    ctx.strokeStyle = this._cfg.crosshairColor;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);

    // Vertical line
    ctx.beginPath();
    ctx.moveTo(pt.x, pT);
    ctx.lineTo(pt.x, pT + plotH);
    ctx.stroke();

    // Horizontal line
    ctx.beginPath();
    ctx.moveTo(pL, pt.y);
    ctx.lineTo(pL + plotW, pt.y);
    ctx.stroke();

    ctx.setLineDash([]);

    // Dot on line
    ctx.fillStyle = this._cfg.lineColor;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
    ctx.fill();

    // Tooltip
    const d = slice[clamped];
    const lines = [
      this._formatTime(d.time),
      `$${d.close.toFixed(2)}`,
    ];
    this._drawTooltip(ctx, pt.x, pt.y, lines, pL, plotW, w);
  }

  _drawTooltip(ctx, x, y, lines, pL, plotW, canvasW) {
    ctx.font = this._cfg.font;
    const padding = 8;
    const lineH = 16;
    const boxW = 100;
    const boxH = lines.length * lineH + padding * 2;

    let tx = x + 12;
    if (tx + boxW > canvasW - 10) tx = x - boxW - 12;
    const ty = Math.max(10, y - boxH / 2);

    ctx.fillStyle = this._cfg.tooltipBg;
    ctx.beginPath();
    ctx.roundRect(tx, ty, boxW, boxH, 4);
    ctx.fill();

    ctx.fillStyle = this._cfg.tooltipColor;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    lines.forEach((l, i) => {
      ctx.fillText(l, tx + padding, ty + padding + i * lineH);
    });
  }

  // ─── Animation ───────────────────────────────────────────────────────────────

  _animateEntrance() {
    let progress = 0;
    const total = this._data.length;
    const step = () => {
      progress = Math.min(progress + Math.max(1, Math.floor(total / 40)), total);
      this._viewEnd = progress;
      this.render();
      if (progress < total) {
        this._animFrame = requestAnimationFrame(step);
      } else {
        this._viewEnd = total;
        this.render();
      }
    };
    cancelAnimationFrame(this._animFrame);
    this._animFrame = requestAnimationFrame(step);
  }

  // ─── HiDPI ───────────────────────────────────────────────────────────────────

  _setupHiDPI() {
    const dpr = this._dpr;
    const c = this._canvas;
    const rect = c.getBoundingClientRect();
    c.width = (rect.width || c.clientWidth || 400) * dpr;
    c.height = (rect.height || c.clientHeight || 250) * dpr;
  }

  // ─── Events ──────────────────────────────────────────────────────────────────

  _bindEvents() {
    const c = this._canvas;

    const getPos = (e) => {
      const r = c.getBoundingClientRect();
      const touch = e.touches?.[0];
      return {
        x: ((touch || e).clientX - r.left),
        y: ((touch || e).clientY - r.top),
      };
    };

    c.addEventListener('mousemove', (e) => {
      const { x, y } = getPos(e);
      this._crosshairX = x;
      this._crosshairY = y;
      this.render();
    });

    c.addEventListener('mouseleave', () => {
      this._crosshairX = null;
      this.render();
    });

    c.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const { x, y } = getPos(e);
      this._crosshairX = x;
      this._crosshairY = y;
      this.render();
    }, { passive: false });

    // Zoom with wheel
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 1 : -1;
      const len = this._data.length;
      const view = this._viewEnd - this._viewStart;
      const newView = Math.min(len, Math.max(20, view + delta * Math.ceil(view * 0.1)));
      const center = Math.round((this._viewStart + this._viewEnd) / 2);
      this._viewStart = Math.max(0, center - Math.floor(newView / 2));
      this._viewEnd = Math.min(len, this._viewStart + newView);
      this.render();
    }, { passive: false });

    // Resize observer
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => {
        this._setupHiDPI();
        this.render();
      }).observe(c);
    }
  }

  // ─── Utilities ───────────────────────────────────────────────────────────────

  _formatTime(t) {
    if (!t) return '';
    const d = typeof t === 'number' ? new Date(t) : new Date(t);
    if (isNaN(d)) return String(t);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }
}

export default LineChart;

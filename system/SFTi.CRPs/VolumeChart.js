/**
 * SFTi.CRPs/VolumeChart.js — Volume Bar Chart
 *
 * Standalone volume renderer that can be used independently or
 * embedded as the volume sub-panel inside CandleChart.js.
 *
 * Usage:
 *   const vchart = new VolumeChart(canvas, config);
 *   vchart.setData(candles); // [{time, close, open, volume}]
 *   vchart.render();
 */

export class VolumeChart {
  constructor(canvas, config = {}) {
    this._canvas = canvas;
    this._ctx = canvas.getContext('2d');
    this._cfg = {
      upColor: config.upColor || 'rgba(38,166,154,0.7)',
      downColor: config.downColor || 'rgba(239,83,80,0.7)',
      gridColor: config.gridColor || 'rgba(255,255,255,0.06)',
      axisColor: config.axisColor || 'rgba(255,255,255,0.35)',
      font: config.font || '10px -apple-system, SF Pro Text, sans-serif',
      padLeft: config.padLeft || 60,
      padRight: config.padRight || 20,
      padTop: config.padTop || 10,
      padBottom: config.padBottom || 30,
      ...config,
    };
    this._data = [];
    this._dpr = window.devicePixelRatio || 1;
    this._setupHiDPI();
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => { this._setupHiDPI(); this.render(); }).observe(canvas);
    }
  }

  setData(data) {
    this._data = data || [];
    this.render();
  }

  render() {
    const { _ctx: ctx, _canvas: c } = this;
    const dpr = this._dpr;
    const W = c.width / dpr;
    const H = c.height / dpr;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const d = this._data;
    if (!d.length) { ctx.restore(); return; }

    const { padLeft: pL, padRight: pR, padTop: pT, padBottom: pB } = this._cfg;
    const plotW = W - pL - pR;
    const plotH = H - pT - pB;
    const maxVol = Math.max(...d.map((x) => x.volume || 0)) || 1;
    const barW = Math.max(1, Math.floor(plotW / d.length) - 1);

    // Grid
    ctx.strokeStyle = this._cfg.gridColor;
    ctx.lineWidth = 1;
    for (let r = 0; r <= 3; r++) {
      const y = pT + (r / 3) * plotH;
      ctx.beginPath();
      ctx.moveTo(pL, y); ctx.lineTo(pL + plotW, y);
      ctx.stroke();
    }

    // Bars
    d.forEach((bar, i) => {
      const x = pL + (i / d.length) * plotW;
      const h = ((bar.volume || 0) / maxVol) * plotH;
      ctx.fillStyle = (bar.close >= bar.open) ? this._cfg.upColor : this._cfg.downColor;
      ctx.fillRect(x, pT + plotH - h, barW, h);
    });

    // Y axis labels
    ctx.fillStyle = this._cfg.axisColor;
    ctx.font = this._cfg.font;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let r = 0; r <= 3; r++) {
      const v = maxVol * (1 - r / 3);
      const y = pT + (r / 3) * plotH;
      ctx.fillText(this._fmt(v), pL - 4, y);
    }

    // X axis
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const step = Math.max(1, Math.floor(d.length / 6));
    for (let i = 0; i < d.length; i += step) {
      const x = pL + ((i + 0.5) / d.length) * plotW;
      const t = d[i].time;
      const dt = new Date(typeof t === 'number' ? t : t);
      if (!isNaN(dt)) ctx.fillText(`${dt.getMonth() + 1}/${dt.getDate()}`, x, pT + plotH + 4);
    }

    ctx.restore();
  }

  _setupHiDPI() {
    const dpr = this._dpr;
    const c = this._canvas;
    const rect = c.getBoundingClientRect();
    c.width = (rect.width || c.clientWidth || 400) * dpr;
    c.height = (rect.height || c.clientHeight || 120) * dpr;
  }

  _fmt(v) {
    if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return Math.round(v).toString();
  }
}

export default VolumeChart;

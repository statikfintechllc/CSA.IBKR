/**
 * configs/main.chart/js/alignment.js
 * Layout alignment helpers for the main chart panel.
 * Manages how the chart container sizes and positions itself relative
 * to the viewport and other UI panels.
 */

export const MainChartAlignment = {
  /** Compute the pixel height for the main chart canvas. */
  getChartHeight(viewportH, hasSubPanel = true, hasNews = true) {
    let h = viewportH;
    h -= 56;   // top nav bar
    h -= 48;   // ticker input bar
    h -= hasSubPanel ? Math.floor(viewportH * 0.2) : 0;
    h -= hasNews ? Math.floor(viewportH * 0.25) : 0;
    return Math.max(180, h);
  },

  /** Apply responsive sizing to a chart container element. */
  applyLayout(containerEl, viewportH, opts = {}) {
    const h = MainChartAlignment.getChartHeight(viewportH, opts.subPanel, opts.news);
    containerEl.style.height = h + 'px';
    containerEl.style.width = '100%';
    containerEl.style.position = 'relative';
  },
};

export default MainChartAlignment;

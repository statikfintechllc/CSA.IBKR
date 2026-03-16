/**
 * configs/news/js/news.js
 * News feed panel — fetches and renders recent headlines for a ticker.
 */

import { Meta } from '../../../SFTi.IOS/metadata/meta.js';

export class NewsPanel {
  /**
   * @param {HTMLElement} container
   */
  constructor(container) {
    this._el = container;
    this._meta = new Meta();
  }

  async load(ticker, limit = 8) {
    this._el.innerHTML = '<div class="news-loading">Loading news…</div>';
    try {
      const articles = await this._meta.getNews(ticker, limit);
      this._render(articles);
    } catch (err) {
      this._el.innerHTML = `<div class="news-error">Could not load news: ${err.message}</div>`;
    }
  }

  _render(articles) {
    if (!articles || !articles.length) {
      this._el.innerHTML = '<div class="news-empty">No recent news.</div>';
      return;
    }
    this._el.innerHTML = articles.map((a) => `
      <div class="news-item" onclick="window.open('${a.url || a.storyUrl || '#'}', '_blank')">
        <div class="news-headline">${a.headline || a.title || a.story || 'No headline'}</div>
        <div class="news-meta">
          <span class="news-source">${a.provider || a.source || ''}</span>
          <span class="news-time">${this._fmt(a.date || a.published_at || a.ts)}</span>
        </div>
      </div>
    `).join('');
  }

  _fmt(ts) {
    if (!ts) return '';
    const d = new Date(typeof ts === 'number' ? ts * 1000 : ts);
    if (isNaN(d)) return '';
    const now = Date.now();
    const diff = now - d.getTime();
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }
}

export default NewsPanel;

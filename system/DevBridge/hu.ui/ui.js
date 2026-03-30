
/* hu.ui/ui.js - UI layer for cards and connection state */
const app = {
  i: null,
  status: null,
  queue: null,
  log: null,
  connections: null,
  history: null,
};

function el(name, attrs = {}, ...children) {
  const e = document.createElement(name);
  Object.entries(attrs).forEach(([k, v]) => { if (k.startsWith('on')) e[k] = v; else e.setAttribute(k, v); });
  children.flat(10).forEach(c => { e.append(typeof c) == 'string' ? e.appendChild(document.createTextNode(c)) : e.appendChild(c) });
  return e;
}

function fmtTime(ts) {
  const d = new Date(ts);
  return `${d.toLocaleTimeString()} ${d.toLocaleDateString()}`;
}

function pushLog(msg) {
  if (!app.log) return;
  const node = el('div', { class: 'log-entry' }, `[${fmtTime(Date.now())}] ${JSON.stringify(msg)}`);
  app.log.prepend(node);
  if (app.log.childElementCount > 150) app.log.removeChild(app.log.lastChild);
}

function updateStatus(connected, meta = {}) {
  if (!app.status) return;
  app.status.textContent = connected ? 'ONLINE' : 'OFFLINE';
  app.status.className = connected ? 'status online' : 'status offline';
  let details = `Server: ${meta.server || 'unknown'}  Device:${meta.ip || location.hostname}`;
  if (meta.error) details += ` Error:${meta.error}`;
  if (meta.ios) details += ` UserAgent:${meta.ios}`;
  const node = el('div', { class: 'conn-entry' }, `${fmtTime(Date.now())} - ${details}`);
  app.history.prepend(node);
  if (app.history.childElementCount > 40) app.history.removeChild(app.history.lastChild);
}

function appendQueue(card) {
  if (!app.queue) return;
  const cardNode = el('article', { class: 'card item-card' },
    el('div', { class: 'card-type' }, `ID: ${card.id}`),
    el('div', { class: 'card-title' }, `Type: ${card.type}`),
    el('div', { class: 'card-preview' }, card.prompt || JSON.stringify(card.input || card.data || {})),
    el('div', { class: 'card-state' }, `Status: ${card.status || 'pending'}`));
  app.queue.appendChild(cardNode);
  if (app.queue.childElementCount > 60) app.queue.removeChild(app.queue.firstChild);
}

window.addEventListener('DOMContentLoaded', () => {
  app.status = document.getElementById('status');
  app.queue = document.getElementById('queue');
  app.log = document.getElementById('log');
  app.history = document.getElementById('history');
  window.addEventListener('sfti:log', e => pushLog(e.detail));
  window.addEventListener('sfti:queue', e => (Array.isArray(e.detail) ? e.detail : [e.detail]).forEach(appendQueue));
  window.addEventListener('sfti:connected', e => updateStatus(true, e.detail));
  window.addEventListener('sfti:disconnected', e => updateStatus(false, e.detail));

  if (window.navigator.userAgent.includes('iPhone') || window.navigator.userAgent.includes('iPad')) {
    const c = el('div', { class: 'ios-warning' },
      'iOS device detected: Make sure you are using LAN IP from your computer (not 127.0.0.1).',
      el('br'),
      `UserAgent: ${navigator.userAgent}`);
    document.body.prepend(c);
  }
  setTimeout(() => {
    const host = location.hostname;
    if (host === '127.0.0.1' || host === 'localhost') {
      const c2 = el('div', { class: 'ios-warning' }, '⚠ Your phone must use your machine LAN address (e.g. 192.168.x.x), not 127.0.0.1.');
      document.body.prepend(c2);
    }
  }, 1000);
  let offlineSince = null;
  const offlineCheck = () => {
    if (!navigator.onLine) {
      if (!offlineSince) offlineSince = Date.now();
      if (Date.now() - offlineSince > 18000) {
        console.warn('Reloading because offline too long');
        location.reload();
      }
    } else {
      offlineSince = null;
    }
  };
  setInterval(offlineCheck, 5000);

  updateStatus(false, { server: window.SERVER_BASE || `${location.protocol}//${location.host}` });
});

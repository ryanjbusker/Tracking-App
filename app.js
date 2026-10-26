'use strict';

/* =========================================================================
   Contrail — live flight tracking for student pilots.
   Primary: ADS-B (transponder) by tail number, relayed by server.js.
   Backup:  pilot phone GPS -> batched points -> ntfy.sh topic.
   Watchers: push alert (ntfy app) -> live map that merges both sources.
   ========================================================================= */

/* ---------- Config ---------- */
const NTFY = 'https://ntfy.sh';
const API_BASE = typeof window.Capacitor !== 'undefined' && window.Capacitor.isNativePlatform?.() 
  ? 'https://contrail-xnd3.onrender.com/api' 
  : 'api';  // relative when on web, full URL for native
const API = API_BASE;
const ADSB_FRESH = 60;    // seconds an ADS-B position still counts as live
const SAMPLE_SEC = 5;     // one track point every 5 s
const MAX_PTS = 10;       // points per message, keeps each message small
const HISTORY = '12h';    // ntfy.sh keeps messages ~12 h, so that is how far back watchers can see
const COLORS = ['#3b7bff', '#16a34a', '#f59e0b', '#ef4444', '#a855f7', '#0ea5a4', '#ec4899', '#64748b'];
const DEMO_ORIGIN = [39.3257, -76.4138]; // Martin State Airport (KMTN)
const M2FT = 3.28084;
const MS2KT = 1.943844;

/* ---------- Capacitor / Native App Support ---------- */
const isNative = typeof window.Capacitor !== 'undefined';
let pushToken = null;

async function initNativePush() {
  if (!isNative) return;
  
  try {
    const { PushNotifications } = window.Capacitor.Plugins;
    
    // Request permission
    let permStatus = await PushNotifications.checkPermissions();
    if (permStatus.receive === 'prompt') {
      permStatus = await PushNotifications.requestPermissions();
    }
    if (permStatus.receive !== 'granted') {
      console.warn('Push notification permission denied');
      return;
    }
    
    // Register for push
    await PushNotifications.register();
    
    // Listen for registration
    PushNotifications.addListener('registration', async (token) => {
      console.log('Push token:', token.value);
      pushToken = token.value;
      
      // Register with server (iOS APNs token)
      const p = profile();
      if (p) {
        await fetch(`${API}/device/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel: p.channel, token: token.value, platform: 'ios' }),
        }).catch(console.error);
      }
    });
    
    // Handle push notification received
    PushNotifications.addListener('pushNotificationReceived', (notification) => {
      console.log('Push received:', notification);
    });
    
    // Handle push notification tapped
    PushNotifications.addListener('pushNotificationActionPerformed', (notification) => {
      const data = notification.notification.data;
      if (data.url) {
        try {
          const url = new URL(data.url);
          location.hash = url.hash || '#/';
        } catch {
          if (data.channel) location.hash = `#/track/${data.channel}/Pilot`;
        }
      }
    });
    
  } catch (err) {
    console.error('Push init failed:', err);
  }
}

// Initialize on boot
if (isNative) {
  document.addEventListener('DOMContentLoaded', initNativePush);
}

/* ---------- Tiny helpers ---------- */
const app = document.getElementById('app');
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const now = () => Math.floor(Date.now() / 1000);

const store = {
  get(k, d) { try { const v = localStorage.getItem('contrail.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('contrail.' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('contrail.' + k); } catch {} },
};

function rid(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
}

const profile = () => store.get('profile');
const saveProfile = (p) => store.set('profile', p);
const dataTopic = (ch) => `contrail-${ch}`;
const alertTopic = (ch) => `contrail-${ch}-alerts`;
const baseUrl = () => location.href.split('#')[0];
const trackUrl = (p) => `${baseUrl()}#/track/${p.channel}/${encodeURIComponent(p.name)}`;
const followUrl = (p) => `${baseUrl()}#/follow/${p.channel}/${encodeURIComponent(p.name)}`;

function nmBetween(a, b) {
  const R = 3440.065, r = Math.PI / 180;
  const dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearing(a, b) {
  const r = Math.PI / 180;
  const y = Math.sin((b[1] - a[1]) * r) * Math.cos(b[0] * r);
  const x = Math.cos(a[0] * r) * Math.sin(b[0] * r) - Math.sin(a[0] * r) * Math.cos(b[0] * r) * Math.cos((b[1] - a[1]) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
function fmtDur(s) {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
const fmtHrs = (s) => `${(s / 3600).toFixed(1)} h`;
function ago(t) {
  const s = Math.max(0, now() - t);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
const fmtTime = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDate = (t) => new Date(t * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' });
const fmtHdg = (v) => (v == null ? '—' : String(Math.round(v) % 360 || 360).padStart(3, '0'));
function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

async function copy(text, label = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(label); }
  catch { prompt('Copy this:', text); }
}

async function share(title, text, url) {
  if (navigator.share) {
    try { await navigator.share({ title, text, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  copy(url, 'Link copied');
}

/* ---------- Icons ---------- */
const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
const PLANE_PATH = 'M12 2c.8 0 1.4.9 1.4 2v5.2l7.6 4.4v2l-7.6-2.3v4.6l2.2 1.6V21L12 20l-3.6 1v-1.5l2.2-1.6v-4.6L3 15.6v-2l7.6-4.4V4c0-1.1.6-2 1.4-2z';
const I = {
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  check: svg('<path d="M20 6 9 17l-5-5"/>', 'stroke-width="3"'),
  more: svg('<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>'),
  share: svg('<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="m16 6-4-4-4 4"/><path d="M12 2v13"/>'),
  bell: svg('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'),
  back: svg('<path d="m15 18-6-6 6-6"/>'),
  locate: svg('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'),
  layers: svg('<path d="m12 2 10 5-10 5L2 7l10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>'),
  users: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>'),
  map: svg('<path d="M9 3 3 6v15l6-3 6 3 6-3V3l-6 3-6-3z"/><path d="M9 3v15M15 6v15"/>'),
  alert: svg('<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>'),
  play: svg('<path d="M6 4l14 8-14 8V4z" fill="currentColor"/>'),
  plane: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="${PLANE_PATH}"/></svg>`,
};

/* ---------- Outbox: everything sent to ntfy goes through here, so nothing is lost offline ---------- */
const outbox = {
  busy: false,
  ok: true,
  lastOk: 0,
  pending: () => store.get('outbox', []).length,
  add(item) {
    const o = store.get('outbox', []);
    o.push({ id: rid(8), ...item });
    store.set('outbox', o);
  },
  async flush() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (let o = store.get('outbox', []); o.length; o = store.get('outbox', [])) {
        const it = o[0];
        const res = it.alert
          ? await fetch(NTFY + '/', { method: 'POST', body: JSON.stringify({ priority: 4, ...it.alert }) })
          : await fetch(`${NTFY}/${it.topic}`, { method: 'POST', body: JSON.stringify(it.body) });
        if (!res.ok && res.status !== 400) throw new Error('ntfy ' + res.status);
        store.set('outbox', store.get('outbox', []).filter((x) => x.id !== it.id));
        this.lastOk = now();
      }
      this.ok = true;
    } catch {
      this.ok = false;
    } finally {
      this.busy = false;
    }
  },
};
window.addEventListener('online', () => outbox.flush());

/* ---------- Contrail server (ADS-B relay) ---------- */
async function apiGet(p) {
  try {
    const r = await fetch(`${API}${p}`, { cache: 'no-store' });
    if (!r.ok) {
      const errorMsg = `API error: ${r.status} ${r.statusText}`;
      console.error(errorMsg, p);
      toast(errorMsg, 5000);
      return null;
    }
    return await r.json();
  } catch (err) {
    const errorMsg = `Network error: ${err.message}`;
    console.error(errorMsg, p);
    toast(errorMsg, 5000);
    return null;
  }
}
function apiPost(p, body) {
  return fetch(`${API}${p}`, { 
    method: 'POST', 
    headers: { 'Content-Type': 'application/json' }, 
    body: JSON.stringify(body) 
  }).catch((err) => {
    const errorMsg = `Network error: ${err.message}`;
    console.error(errorMsg, p);
    toast(errorMsg, 5000);
  });
}
const adsbUrl = (tail, since) => `/ac/${encodeURIComponent(tail)}?since=${since}`;

/* ---------- Polyline smoothing (Catmull-Rom) ---------- */
// Smooth a polyline using Catmull-Rom interpolation for curved trails
function smoothPolyline(points, segments = 10) {
  if (points.length < 2) return points;
  
  const smooth = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    
    for (let t = 0; t < segments; t++) {
      const u = t / segments;
      const u2 = u * u;
      const u3 = u2 * u;
      
      // Catmull-Rom formula
      const lat = 0.5 * (
        2 * p1[0] +
        (-p0[0] + p2[0]) * u +
        (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * u2 +
        (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * u3
      );
      const lon = 0.5 * (
        2 * p1[1] +
        (-p0[1] + p2[1]) * u +
        (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * u2 +
        (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * u3
      );
      smooth.push([lat, lon]);
    }
  }
  smooth.push(points[points.length - 1]);
  return smooth;
}

/* ---------- Map ---------- */
function makeMap(el, center = DEMO_ORIGIN, zoom = 10) {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const esri = (svc) => `https://server.arcgisonline.com/ArcGIS/rest/services/${svc}/MapServer/tile/{z}/{y}/{x}`;
  const gray = dark ? 'Dark' : 'Light';
  const layers = {
    map: L.layerGroup([
      L.tileLayer(esri(`Canvas/World_${gray}_Gray_Base`), { maxNativeZoom: 16, maxZoom: 19, attribution: 'Map © Esri' }),
      L.tileLayer(esri(`Canvas/World_${gray}_Gray_Reference`), { maxNativeZoom: 16, maxZoom: 19 }),
    ]),
    vfr: L.tileLayer('https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile/{z}/{y}/{x}', {
      maxNativeZoom: 12, maxZoom: 16, attribution: 'VFR Sectional · FAA',
    }),
    sat: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 18, attribution: 'Imagery © Esri',
    }),
  };
  const names = { map: 'Map', vfr: 'VFR sectional', sat: 'Satellite' };
  const map = L.map(el, { zoomControl: false }).setView(center, zoom);
  map.attributionControl.setPrefix(false);
  let current = layers[store.get('layer')] ? store.get('layer') : 'map';
  layers[current].addTo(map);
  map.cycleLayer = () => {
    const order = Object.keys(layers);
    map.removeLayer(layers[current]);
    current = order[(order.indexOf(current) + 1) % order.length];
    layers[current].addTo(map);
    store.set('layer', current);
    toast(names[current]);
  };
  setTimeout(() => map.invalidateSize(), 50);
  cleanup.push(() => map.remove());
  return map;
}

function planeIcon(color, trk, live) {
  return L.divIcon({
    className: '',
    iconSize: [44, 44],
    iconAnchor: [22, 22],
    html: `<div class="pm ${live ? 'is-live' : ''}" style="--c:${color}"><span class="pm-pulse"></span><svg viewBox="0 0 24 24" style="transform:rotate(${trk || 0}deg)"><path d="${PLANE_PATH}"/></svg></div>`,
  });
}
const dotIcon = (color) => L.divIcon({ className: '', iconSize: [12, 12], iconAnchor: [6, 6], html: `<div class="start-dot" style="--c:${color}"></div>` });

/* ---------- Sheets ---------- */
function openSheet(html, onMount) {
  const root = $('#sheet-root');
  root.innerHTML = `<div class="scrim"></div><div class="sheet" role="dialog" aria-modal="true"><div class="grabber"></div>${html}</div>`;
  root.classList.add('open');
  $('.scrim', root).onclick = closeSheet;
  onMount?.(root);
}
function closeSheet() {
  const root = $('#sheet-root');
  root.classList.remove('open');
  root.innerHTML = '';
}
function confirmSheet({ title, lead, ok, cancel = 'Cancel', danger }) {
  return new Promise((resolve) => {
    openSheet(`<h2>${esc(title)}</h2><p class="lead">${esc(lead)}</p>
      <div class="sheet-actions">
        <button class="btn btn-lg btn-block ${danger ? 'btn-danger' : 'btn-primary'}" id="ok">${esc(ok)}</button>
        <button class="btn btn-lg btn-block" id="no">${esc(cancel)}</button>
      </div>`, (r) => {
      $('#ok', r).onclick = () => { closeSheet(); resolve(true); };
      $('#no', r).onclick = () => { closeSheet(); resolve(false); };
      $('.scrim', r).onclick = () => { closeSheet(); resolve(false); };
    });
  });
}

/* ---------- Router ---------- */
let cleanup = [];
function route() {
  cleanup.splice(0).forEach((fn) => { try { fn(); } catch {} });
  closeSheet();
  window.scrollTo(0, 0);
  const [view, a, b] = (location.hash.slice(1) || '/').split('/').filter(Boolean);
  const name = b ? decodeURIComponent(b) : '';
  if (view === 'track' && a) return viewTrack(a, name);
  if (view === 'follow' && a) return viewFollow(a, name);
  if (!profile()) return viewOnboard();
  if (store.get('active')) return viewFly();
  if (view === 'settings') return viewSettings();
  return viewHome();
}
window.addEventListener('hashchange', route);

/* ---------- Onboarding ---------- */
function viewOnboard() {
  const feature = (icon, title, text) => `<div class="feature"><div class="glyph">${icon}</div><div><b>${title}</b><span>${text}</span></div></div>`;
  app.innerHTML = `
    <div class="onboard">
      <img class="logo" src="icons/icon.svg" alt="">
      <h1>You fly.<br><em>They follow along.</em></h1>
      <p class="lead">Contrail turns your phone into a live tracker for your training flights.</p>
      <div class="features">
        ${feature(I.plane, 'One tap per lesson', 'Save the aircraft you train in. Pick one and go.')}
        ${feature(I.bell, 'Your people get notified', 'A push alert when you start, and another when you land.')}
        ${feature(I.map, 'Live map', 'Position, altitude, speed and your full track, in real time.')}
      </div>
      <form id="f">
        <div class="field"><label for="name">Your first name</label>
          <input class="input" id="name" autocomplete="given-name" placeholder="e.g. Alex" required maxlength="24"></div>
        <button class="btn btn-primary btn-lg btn-block">Get started</button>
      </form>
    </div>`;
  $('#f').onsubmit = (e) => {
    e.preventDefault();
    const name = $('#name').value.trim();
    if (!name) return;
    saveProfile({ name, channel: rid(16), interval: 30, demo: false });
    route();
  };
}

/* ---------- Home ---------- */
function planeStats() {
  const s = {};
  for (const f of store.get('log', [])) {
    const x = (s[f.planeId] ||= { flights: 0, secs: 0, last: 0 });
    x.flights++;
    x.secs += f.end - f.start;
    x.last = Math.max(x.last, f.end);
  }
  return s;
}
function sortedPlanes() {
  const stats = planeStats();
  return store.get('planes', []).slice().sort((a, b) => (stats[b.id]?.last || b.added || 0) - (stats[a.id]?.last || a.added || 0));
}

function viewHome() {
  const p = profile();
  const planes = sortedPlanes();
  const stats = planeStats();
  const log = store.get('log', []).slice(0, 5);
  let selected = store.get('selected');
  if (!planes.some((pl) => pl.id === selected)) selected = planes[0]?.id || null;

  const card = (pl) => {
    const s = stats[pl.id];
    const meta = s ? `${s.flights} flight${s.flights === 1 ? '' : 's'} · ${fmtHrs(s.secs)}` : 'Not flown yet';
    return `<div class="plane ${pl.id === selected ? 'is-selected' : ''}" role="button" tabindex="0" data-id="${pl.id}" style="--c:${pl.color}" aria-pressed="${pl.id === selected}">
      <button class="edit" data-edit="${pl.id}" aria-label="Edit ${esc(pl.tail)}">${I.more}</button>
      <span class="tail">${esc(pl.tail)}</span>
      <span class="type">${esc(pl.type || 'Aircraft')}</span>
      <span class="meta">${meta}</span>
      <span class="check">${I.check}</span>
    </div>`;
  };

  const flightRow = (f) => `<div class="list-item" style="--c:${f.color}">
      <span class="dot"></span>
      <div class="main"><div class="title mono">${esc(f.tail)}</div><div class="sub">${fmtDate(f.start)} · ${fmtTime(f.start)} – ${fmtTime(f.end)}</div></div>
      <div class="end">${fmtHrs(f.end - f.start)}<small>${Math.round(f.dist || 0)} nm</small></div>
    </div>`;

  app.innerHTML = `
    <header class="topbar">
      <div class="brand"><img src="icons/icon.svg" alt="">Contrail</div>
      <a class="icon-btn" href="#/settings" aria-label="Settings">${I.gear}</a>
    </header>
    <main class="page">
      <section class="hero">
        <p class="eyebrow">${greeting()}</p>
        <h1>Ready to fly, ${esc(p.name)}?</h1>
        <p>${planes.length ? 'Pick today’s aircraft and start your flight. Your people get a heads-up automatically.' : 'Add the aircraft you train in. You only do this once.'}</p>
      </section>

      <section>
        <div class="section-head"><h2>Your aircraft</h2><span>${planes.length ? planes.length + ' saved' : ''}</span></div>
        <div class="fleet" id="fleet">
          ${planes.map(card).join('')}
          <button class="plane plane-add" id="add"><span class="plus">${I.plus}</span>Add aircraft</button>
        </div>
      </section>

      <section class="card watch-card">
        <div class="row">
          <div class="glyph">${I.users}</div>
          <div><h3>Your people</h3><p>Send them your invite once. They’ll get alerts every time you fly and can watch you live.</p></div>
        </div>
        <div class="btn-row">
          <button class="btn" id="invite">${I.share}Invite</button>
          <a class="btn" href="${esc(trackUrl(p))}">${I.map}My live map</a>
        </div>
      </section>

      <section>
        <div class="section-head"><h2>Recent flights</h2><span>${log.length ? '' : ''}</span></div>
        <div class="list">${log.length ? log.map(flightRow).join('') : '<div class="empty">Your logged flights will show up here.</div>'}</div>
      </section>
    </main>
    <div class="dock"><div><button class="btn btn-primary btn-lg btn-block" id="start"></button></div></div>`;

  const startBtn = $('#start');
  const paintStart = () => {
    const pl = planes.find((x) => x.id === selected);
    startBtn.disabled = !pl;
    startBtn.innerHTML = pl ? `${I.play}Start flight · <span class="mono">${esc(pl.tail)}</span>` : planes.length ? 'Select an aircraft' : 'Add an aircraft to start';
  };
  paintStart();

  const select = (id) => {
    selected = id;
    store.set('selected', id);
    document.querySelectorAll('.plane[data-id]').forEach((el) => {
      const on = el.dataset.id === id;
      el.classList.toggle('is-selected', on);
      el.setAttribute('aria-pressed', on);
    });
    paintStart();
  };

  $('#fleet').onclick = (e) => {
    const edit = e.target.closest('[data-edit]');
    if (edit) return planeSheet(store.get('planes', []).find((x) => x.id === edit.dataset.edit));
    const pl = e.target.closest('.plane[data-id]');
    if (pl) select(pl.dataset.id);
  };
  $('#fleet').onkeydown = (e) => {
    const pl = e.target.closest('.plane[data-id]');
    if (pl && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(pl.dataset.id); }
  };
  $('#add').onclick = () => planeSheet(null);
  $('#invite').onclick = () => share('Follow my flights', `Follow my training flights live on Contrail — set up alerts here:`, followUrl(p));
  startBtn.onclick = () => startFlight(planes.find((x) => x.id === selected));

  outbox.flush(); // deliver anything left over from a flight that ended offline
}

function planeSheet(plane) {
  const isNew = !plane;
  const planes = store.get('planes', []);
  const draft = plane ? { ...plane } : { id: rid(6), tail: '', type: '', color: COLORS[planes.length % COLORS.length], added: now() };
  openSheet(`
    <h2>${isNew ? 'Add aircraft' : 'Edit aircraft'}</h2>
    <p class="lead">${isNew ? 'This is what your people will see on the map.' : 'Changes apply to future flights.'}</p>
    <form id="pf">
      <div class="field"><label for="tail">Tail number</label>
        <input class="input mono" id="tail" required maxlength="8" placeholder="N12345" value="${esc(draft.tail)}" autocapitalize="characters" autocomplete="off" spellcheck="false"></div>
      <div class="field"><label for="type">Type</label>
        <input class="input" id="type" maxlength="28" placeholder="Cessna 172S" value="${esc(draft.type)}"></div>
      <div class="field"><label>Color on the map</label>
        <div class="swatches">${COLORS.map((c) => `<button type="button" class="swatch ${c === draft.color ? 'is-on' : ''}" style="--c:${c}" data-c="${c}" aria-label="Color"></button>`).join('')}</div></div>
      <div class="sheet-actions">
        <button class="btn btn-primary btn-lg btn-block">${isNew ? 'Add aircraft' : 'Save'}</button>
        ${isNew ? '' : '<button type="button" class="btn btn-ghost btn-block" id="del" style="color:var(--danger)">Remove aircraft</button>'}
      </div>
    </form>`, (r) => {
    $('.swatches', r).onclick = (e) => {
      const b = e.target.closest('[data-c]');
      if (!b) return;
      draft.color = b.dataset.c;
      r.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('is-on', s === b));
    };
    $('#pf', r).onsubmit = (e) => {
      e.preventDefault();
      draft.tail = $('#tail', r).value.trim().toUpperCase();
      draft.type = $('#type', r).value.trim();
      if (!draft.tail) return;
      const list = store.get('planes', []).filter((x) => x.id !== draft.id);
      list.push(draft);
      store.set('planes', list);
      if (isNew) store.set('selected', draft.id);
      closeSheet();
      route();
    };
    const del = $('#del', r);
    if (del) del.onclick = () => {
      store.set('planes', store.get('planes', []).filter((x) => x.id !== draft.id));
      closeSheet();
      route();
    };
    if (isNew) setTimeout(() => $('#tail', r)?.focus(), 300);
  });
}

/* ---------- Flight (pilot) ---------- */
function startFlight(plane) {
  if (!plane) return;
  store.set('active', {
    fid: rid(8), planeId: plane.id, tail: plane.tail, type: plane.type, color: plane.color,
    start: now(), announced: false, buf: [], track: [], dist: 0, maxAlt: 0, lastT: 0,
  });
  location.hash = '#/fly';
}

function viewFly() {
  const p = profile();
  const a = store.get('active');
  const save = () => store.set('active', a);
  const live = { adsb: null, apiOk: null, lastAdsbSeen: 0 };

  app.innerHTML = `
    <div class="map-screen">
      <div class="map" id="map"></div>
      <div class="overlay-top">
        <div class="pill"><span class="status idle" id="st"><i></i>Transponder</span><span class="mono">${esc(a.tail)}</span></div>
        <div class="pill mono" id="elapsed">0:00</div>
      </div>
      <div class="map-tools" style="top:calc(var(--safe-top) + 64px)">
        <button class="icon-btn" id="layers" aria-label="Map style">${I.layers}</button>
        <button class="icon-btn is-on" id="follow" aria-label="Follow aircraft">${I.locate}</button>
      </div>
      <div class="panel">
        <div class="stats">
          <div class="stat"><small>Alt</small><b id="s-alt">—</b></div>
          <div class="stat"><small>GS</small><b id="s-gs">—</b></div>
          <div class="stat"><small>Trk</small><b id="s-trk">—</b></div>
          <div class="stat"><small>Dist</small><b id="s-dist">—</b></div>
        </div>
        <div class="sources"><span class="src" id="src-adsb"></span></div>
        <div id="traffic-indicator" style="margin:8px 0;padding:8px;background:rgba(0,0,0,0.05);border-radius:8px;font-size:13px;display:none;">
          <div style="font-weight:600;margin-bottom:4px;">Nearest Traffic</div>
          <div id="traffic-text" style="color:#666;"></div>
        </div>
        <div id="banner"></div>
        <div class="btn-row">
          <button class="btn" id="share">${I.share}Share live link</button>
          <button class="btn btn-danger" id="end">End flight</button>
        </div>
      </div>
    </div>`;

  const last = a.track[a.track.length - 1];
  const map = makeMap($('#map'), last ? [last[1], last[2]] : DEMO_ORIGIN, last ? 13 : 10);
  
  // Use smoothed trail for curved appearance
  const rawPoints = a.track.map((q) => [q[1], q[2]]);
  const smoothPoints = rawPoints.length > 2 ? smoothPolyline(rawPoints, 8) : rawPoints;
  const trail = L.polyline(smoothPoints, { 
    color: a.color, weight: 4, opacity: 0.9, lineCap: 'round', lineJoin: 'round' 
  }).addTo(map);
  if (a.track[0]) L.marker([a.track[0][1], a.track[0][2]], { icon: dotIcon(a.color), interactive: false }).addTo(map);
  
  let marker = null;
  let follow = true;
  let centered = !!last;
  
  // Traffic display
  let trafficMarkers = [];
  let nearestLine = null;
  let traffic = { nearest: null, all: [] };
  
  // Dead-reckoning animation state
  let animFrame = null;
  let lastFix = null;
  let lastFixTime = null;
  let lastFixId = null; // To detect duplicate fixes
  
  const placeMarker = (ll, trk, gs, fixTime, fixId) => {
    // Don't update if this is a duplicate fix
    if (fixId === lastFixId) return;
    
    const newFix = { lat: ll[0], lon: ll[1], trk, gs: gs || 0 };
    const newFixTime = fixTime * 1000; // Convert to milliseconds
    
    // If we have a previous fix, check if new fix is behind predicted position
    if (lastFix && lastFixTime && newFixTime > lastFixTime) {
      const elapsed = (newFixTime - lastFixTime) / 1000;
      if (elapsed < 5 && lastFix.gs > 5) {
        // Calculate where we predicted the plane would be
        const nmTraveled = (lastFix.gs * elapsed) / 3600;
        const radHeading = (lastFix.trk || 0) * Math.PI / 180;
        const dLat = (nmTraveled / 60) * Math.cos(radHeading);
        const dLon = (nmTraveled / 60) * Math.sin(radHeading) / Math.cos(lastFix.lat * Math.PI / 180);
        const predictedLat = lastFix.lat + dLat;
        const predictedLon = lastFix.lon + dLon;
        
        // If new fix is behind prediction, blend instead of snapping
        const distToPredicted = Math.sqrt(Math.pow(newFix.lat - predictedLat, 2) + Math.pow(newFix.lon - predictedLon, 2));
        if (distToPredicted > 0.001) { // ~60m threshold
          // Use predicted position as starting point for next extrapolation
          newFix.lat = predictedLat;
          newFix.lon = predictedLon;
        }
      }
    }
    
    lastFix = newFix;
    lastFixTime = newFixTime;
    lastFixId = fixId;
    
    if (!marker) {
      marker = L.marker([newFix.lat, newFix.lon], { icon: planeIcon(a.color, trk, true), interactive: false, zIndexOffset: 1000 }).addTo(map);
    } else {
      marker.setIcon(planeIcon(a.color, trk, true));
    }
    
    if (!centered) { map.setView(ll, 13); centered = true; }
    else if (follow) map.panTo(ll, { animate: true });
  };
  
  // Continuous dead-reckoning animation
  const deadReckon = () => {
    if (lastFix && lastFixTime) {
      const elapsed = (Date.now() - lastFixTime) / 1000; // seconds
      if (elapsed < 5 && lastFix.gs > 5) { // Only dead-reckon if moving and recent fix
        // Calculate distance traveled: groundspeed (knots) * time (seconds) / 3600 * 60 = nautical miles
        const nmTraveled = (lastFix.gs * elapsed) / 3600;
        // Convert to degrees (rough approximation: 1nm ≈ 1/60 degree)
        const radHeading = (lastFix.trk || 0) * Math.PI / 180;
        const dLat = (nmTraveled / 60) * Math.cos(radHeading);
        const dLon = (nmTraveled / 60) * Math.sin(radHeading) / Math.cos(lastFix.lat * Math.PI / 180);
        
        const projLat = lastFix.lat + dLat;
        const projLon = lastFix.lon + dLon;
        
        if (marker) {
          marker.setLatLng([projLat, projLon]);
          if (follow && elapsed > 0.5) map.panTo([projLat, projLon], { animate: false });
        }
      }
    }
    animFrame = requestAnimationFrame(deadReckon);
  };
  
  deadReckon(); // Start animation loop
  cleanup.push(() => { if (animFrame) cancelAnimationFrame(animFrame); });

  map.on('dragstart', () => { follow = false; $('#follow').classList.remove('is-on'); });
  $('#follow').onclick = () => {
    follow = true;
    $('#follow').classList.add('is-on');
    if (live.adsb) map.setView([live.adsb.lat, live.adsb.lon], Math.max(map.getZoom(), 12));
  };
  $('#layers').onclick = () => map.cycleLayer();
  $('#share').onclick = () => share(`${p.name} is flying`, `Follow my flight in ${a.tail} live:`, trackUrl(p));
  $('#end').onclick = async () => {
    const ok = await confirmSheet({ title: 'End flight?', lead: 'Your people will get a “landed” notification and the flight goes in your log.', ok: 'End flight', cancel: 'Keep tracking', danger: true });
    if (ok) endFlight();
  };

  // Transponder (ADS-B) polling - primary tracking mechanism
  async function pollAdsb() {
    const r = await apiGet(adsbUrl(a.tail, a.start));
    live.apiOk = !!r;
    live.apiResp = r; // Store full response to check feedOk
    live.adsb = r?.ac && r.ac.t >= a.start - 120 ? r.ac : null;
    const ad = live.adsb;
    
    if (ad && now() - ad.t < ADSB_FRESH) {
      live.lastAdsbSeen = now();
      // Update distance tracking
      if (live.lastAd && ad.t > live.lastAd.t && !ad.ground) {
        a.dist += nmBetween([live.lastAd.lat, live.lastAd.lon], [ad.lat, ad.lon]);
      }
      // Update max altitude
      if (ad.alt != null && !ad.ground) {
        a.maxAlt = Math.max(a.maxAlt || 0, ad.alt);
      }
      live.lastAd = ad;
      save();
      placeMarker([ad.lat, ad.lon], ad.trk, ad.gs, ad.t, `${ad.t}-${ad.lat}-${ad.lon}`);
      
      // Only add point if position actually changed (dedupe identical samples)
      const lastPt = a.track[a.track.length - 1];
      const lat = +ad.lat.toFixed(5), lon = +ad.lon.toFixed(5);
      if (!lastPt || lastPt[1] !== lat || lastPt[2] !== lon) {
        const pt = [ad.t, lat, lon, 
                     ad.alt == null || ad.ground ? 0 : Math.round(ad.alt), 
                     ad.gs == null ? null : Math.round(ad.gs), 
                     ad.trk == null ? null : Math.round(ad.trk)];
        a.track.push(pt);
        
        // Update smoothed trail
        const rawPoints = a.track.map((q) => [q[1], q[2]]);
        const smoothPoints = rawPoints.length > 2 ? smoothPolyline(rawPoints, 8) : rawPoints;
        trail.setLatLngs(smoothPoints);
        
        if (a.track.length === 1) L.marker([lat, lon], { icon: dotIcon(a.color), interactive: false }).addTo(map);
        save();
      }
    }
    paint();
  }

  async function pollTraffic() {
    if (!live.adsb || now() - live.adsb.t >= ADSB_FRESH) {
      traffic = { nearest: null, all: [], error: null };
      updateTrafficDisplay();
      return;
    }
    
    try {
      const r = await apiGet(`/traffic/${encodeURIComponent(a.tail)}`);
      if (r) {
        traffic.nearest = r.nearest;
        traffic.all = r.traffic || [];
        traffic.error = null;
        updateTrafficDisplay();
        updateTrafficMarkers();
      } else {
        traffic.error = 'Traffic unavailable';
        updateTrafficDisplay();
      }
    } catch (err) {
      traffic.error = 'Traffic error';
      updateTrafficDisplay();
    }
  }
  
  function updateTrafficDisplay() {
    const indicator = $('#traffic-indicator');
    const text = $('#traffic-text');
    
    if (traffic.error) {
      indicator.style.display = 'block';
      text.innerHTML = `<span style="color:#f59e0b;">${traffic.error}</span>`;
      return;
    }
    
    if (!traffic.nearest) {
      indicator.style.display = 'block';
      text.innerHTML = '<span style="color:#999;">No traffic within 10 nm</span>';
      return;
    }
    
    const t = traffic.nearest;
    const id = t.callsign || t.tail || 'Unknown';
    const distStr = t.dist.toFixed(1);
    const clock = t.clock ? `${t.clock} o'clock` : t.cardinal;
    const altStr = t.relAlt > 0 ? `+${Math.round(t.relAlt)}` : Math.round(t.relAlt);
    const vsIcon = t.vs > 100 ? ' ↑' : t.vs < -100 ? ' ↓' : '';
    
    indicator.style.display = 'block';
    text.innerHTML = `<b>${id}</b> ${distStr} nm, ${clock}, ${altStr} ft${vsIcon}`;
  }
  
  function updateTrafficMarkers() {
    // Clear old markers
    trafficMarkers.forEach(m => map.removeLayer(m));
    trafficMarkers = [];
    if (nearestLine) { map.removeLayer(nearestLine); nearestLine = null; }
    
    if (!traffic.all.length || !live.adsb) return;
    
    // Draw nearest with dashed line
    if (traffic.nearest) {
      const n = traffic.nearest;
      nearestLine = L.polyline([
        [live.adsb.lat, live.adsb.lon],
        [n.lat, n.lon]
      ], { color: '#f59e0b', weight: 2, dashArray: '5, 5', opacity: 0.6 }).addTo(map);
      
      const icon = planeIcon('#f59e0b', n.trk, true);
      const m = L.marker([n.lat, n.lon], { icon, interactive: false, zIndexOffset: 500 }).addTo(map);
      trafficMarkers.push(m);
    }
    
    // Draw other traffic as faint icons
    traffic.all.slice(1, 10).forEach((t) => {
      const icon = planeIcon('#999', t.trk, false);
      const m = L.marker([t.lat, t.lon], { icon, interactive: false, zIndexOffset: 100, opacity: 0.4 }).addTo(map);
      trafficMarkers.push(m);
    });
  }

  function flush() {
    // Transponder-only: no buffered GPS points to flush
    outbox.flush().then(paint);
  }

  function endFlight() {
    flush();
    const end = now();
    const dur = end - a.start;
    
    // Send via native push if available, otherwise ntfy.sh
    if (isNative) {
      apiPost('/flight/end', {
        channel: p.channel,
        tail: a.tail,
        pilotName: p.name,
        duration: dur,
        distance: a.dist,
      });
    } else {
      outbox.add({ topic: dataTopic(p.channel), body: { k: 'e', f: a.fid, t: end } });
      outbox.add({ alert: {
        topic: alertTopic(p.channel),
        title: `${p.name} has landed`,
        message: `${a.tail} · ${fmtHrs(dur)} flight${a.dist >= 1 ? `, ${Math.round(a.dist)} nm` : ''}.`,
        click: trackUrl(p),
        tags: ['white_check_mark'],
      } });
    }
    
    apiPost('/track/end', { tail: a.tail });
    const log = store.get('log', []);
    log.unshift({ fid: a.fid, planeId: a.planeId, tail: a.tail, color: a.color, start: a.start, end, dist: a.dist, maxAlt: a.maxAlt });
    store.set('log', log.slice(0, 200));
    store.del('active');
    outbox.flush();
    toast('Flight logged. Nice work!');
    location.hash = '#/';
  }

  function paint() {
    const ad = live.adsb && now() - live.adsb.t < ADSB_FRESH ? live.adsb : null;
    const alt = ad?.alt, gs = ad?.gs, trk = ad?.trk;
    $('#elapsed').textContent = fmtDur(now() - a.start);
    $('#s-alt').innerHTML = ad?.ground ? 'GND' : alt != null ? `${Math.round(alt).toLocaleString()}<u>ft</u>` : '—';
    $('#s-gs').innerHTML = gs != null ? `${Math.round(gs)}<u>kt</u>` : '—';
    $('#s-trk').innerHTML = trk != null ? `${fmtHdg(trk)}°` : '—';
    $('#s-dist').innerHTML = `${a.dist.toFixed(a.dist < 10 ? 1 : 0)}<u>nm</u>`;

    const state = ad ? 'live' : live.adsb ? 'stale' : 'idle';
    const st = $('#st');
    st.className = `status ${state}`;
    st.innerHTML = `<i></i>${{ idle: 'Searching', live: 'Live', stale: 'No signal' }[state]}`;

    const chip = (el, cls, text) => { el.className = `src ${cls}`; el.innerHTML = `<i></i>${text}`; };
    
    // Show feed status prominently
    const r = live.apiResp; // response from /api/ac
    if (r && r.feedOk === false) {
      chip($('#src-adsb'), 'warn', 'Feed unavailable, retrying…');
    } else if (live.apiOk === false) {
      chip($('#src-adsb'), 'warn', 'Transponder: server unavailable');
    } else if (ad) {
      chip($('#src-adsb'), 'on', `Transponder · ${ago(ad.t)}`);
    } else if (live.adsb) {
      const minAgo = Math.floor((now() - live.adsb.t) / 60);
      chip($('#src-adsb'), 'warn', `No transponder signal, last seen ${minAgo} min ago`);
    } else if (live.apiOk == null) {
      chip($('#src-adsb'), '', 'Transponder · checking…');
    } else {
      chip($('#src-adsb'), '', 'Transponder · not seen yet');
    }

    let banner = '';
    if (ad && now() - a.start < 600) {
      banner = `<div class="banner info">${I.check}<span>Your transponder is being tracked. You can lock your phone.</span></div>`;
    } else if (!ad && live.adsb && now() - live.adsb.t > 300) {
      const minAgo = Math.floor((now() - live.adsb.t) / 60);
      banner = `<div class="banner">${I.alert}<span>No transponder signal for ${minAgo} minutes. Make sure your transponder is on.</span></div>`;
    } else if (!ad && !live.adsb && now() - a.start > 600) {
      banner = `<div class="banner">${I.alert}<span>Transponder not detected. Make sure it's on and set to ALT mode.</span></div>`;
    }
    const b = $('#banner');
    if (b.innerHTML !== banner) b.innerHTML = banner;
  }

  const onVis = () => {
    if (document.visibilityState === 'hidden') return;
    pollAdsb();
  };
  document.addEventListener('visibilitychange', onVis);
  cleanup.push(() => document.removeEventListener('visibilitychange', onVis));


  // Ask the server to follow this tail; repeat in case it restarted (free hosting sleeps).
  apiPost('/track', { tail: a.tail });
  pollAdsb();
  const register = setInterval(() => apiPost('/track', { tail: a.tail }), 5 * 60 * 1000);
  const adsbTimer = setInterval(pollAdsb, 1000);
  
  // Poll traffic every 3 seconds
  pollTraffic();
  const trafficTimer = setInterval(pollTraffic, 3000);

  const flushTimer = setInterval(flush, (p.interval || 30) * 1000);
  const clock = setInterval(paint, 1000);
  cleanup.push(() => { 
    clearInterval(flushTimer); 
    clearInterval(clock); 
    clearInterval(register); 
    clearInterval(adsbTimer); 
    clearInterval(trafficTimer);
  });

  if (!a.announced) {
    // Send via native push if available, otherwise ntfy.sh
    if (isNative) {
      apiPost('/flight/start', {
        channel: p.channel,
        tail: a.tail,
        pilotName: p.name,
        type: a.type,
      });
    } else {
      outbox.add({ topic: dataTopic(p.channel), body: { k: 's', f: a.fid, n: p.name, tail: a.tail, type: a.type, c: a.color, t: a.start, iv: p.interval || 30 } });
      outbox.add({ alert: {
        topic: alertTopic(p.channel),
        title: `${p.name} started a flight`,
        message: `${a.tail}${a.type ? ' · ' + a.type : ''} — tap to follow along live.`,
        click: trackUrl(p),
        tags: ['airplane'],
      } });
    }
    a.announced = true;
    save();
    outbox.flush().then(paint);
  }
  paint();
}

/* ---------- Live map (watcher) ---------- */
function viewTrack(ch, nameHint) {
  const flights = {};
  const seen = new Set();
  let connected = false;
  let fitted = false;
  let follow = true;
  let lastHtml = '';
  let apiOk = null;

  app.innerHTML = `
    <div class="map-screen">
      <div class="map" id="map"></div>
      <div class="overlay-top">
        <div class="pill"><img src="icons/icon.svg" alt="" style="width:22px;height:22px;border-radius:6px">Contrail</div>
        <a class="pill" href="#/follow/${esc(ch)}/${encodeURIComponent(nameHint)}">${I.bell.replace('<svg', '<svg width="16" height="16"')}Alerts</a>
      </div>
      <div class="map-tools" style="top:calc(var(--safe-top) + 64px)">
        <button class="icon-btn" id="layers" aria-label="Map style">${I.layers}</button>
        <button class="icon-btn is-on" id="follow" aria-label="Follow the aircraft">${I.locate}</button>
      </div>
      <div class="panel" id="panel"></div>
    </div>`;

  const map = makeMap($('#map'), DEMO_ORIGIN, 9);
  const trail = L.polyline([], { weight: 4, opacity: 0.9, lineCap: 'round', lineJoin: 'round' }).addTo(map);
  let marker = null, startMarker = null;
  
  // Traffic display
  let trafficMarkers = [];
  let nearestLine = null;
  let watchTraffic = { nearest: null, all: [] };
  
  // Dead-reckoning animation state
  let animFrame = null;
  let lastFix = null;
  let lastFixTime = null;
  
  // Continuous dead-reckoning animation
  const deadReckon = () => {
    if (lastFix && lastFixTime) {
      const elapsed = (Date.now() - lastFixTime) / 1000; // seconds
      if (elapsed < 5 && lastFix.gs > 5) { // Only dead-reckon if moving and recent fix
        // Calculate distance traveled
        const nmTraveled = (lastFix.gs * elapsed) / 3600;
        const radHeading = (lastFix.trk || 0) * Math.PI / 180;
        const dLat = (nmTraveled / 60) * Math.cos(radHeading);
        const dLon = (nmTraveled / 60) * Math.sin(radHeading) / Math.cos(lastFix.lat * Math.PI / 180);
        
        const projLat = lastFix.lat + dLat;
        const projLon = lastFix.lon + dLon;
        
        if (marker) {
          marker.setLatLng([projLat, projLon]);
          if (follow && elapsed > 0.5) map.panTo([projLat, projLon], { animate: false });
        }
      }
    }
    animFrame = requestAnimationFrame(deadReckon);
  };
  
  deadReckon(); // Start animation loop
  cleanup.push(() => { if (animFrame) cancelAnimationFrame(animFrame); });
  map.on('dragstart', () => { follow = false; $('#follow').classList.remove('is-on'); });
  $('#layers').onclick = () => map.cycleLayer();
  $('#follow').onclick = () => {
    follow = true;
    $('#follow').classList.add('is-on');
    const f = latest();
    const pt = f?.pts[f.pts.length - 1];
    if (pt) map.setView([pt[1], pt[2]], Math.max(map.getZoom(), 12));
  };

  const flight = (fid) => (flights[fid] ||= { fid, pts: [], adsb: [], start: 0, end: 0, seen: 0, v: 0 });
  function ingest(d) {
    if (!d || !d.f) return;
    const f = flight(d.f);
    if (d.k === 's') Object.assign(f, { name: d.n, tail: d.tail, type: d.type, color: d.c, start: d.t, iv: d.iv });
    if (d.k === 'e') f.end = d.t;
    if (d.k === 'p' && Array.isArray(d.p)) {
      for (const pt of d.p) if (!f.pts.length || pt[0] > f.pts[f.pts.length - 1][0]) f.pts.push(pt);
        else if (!f.pts.some((q) => q[0] === pt[0])) { f.pts.push(pt); f.pts.sort((x, y) => x[0] - y[0]); }
    }
    const lastPt = f.pts[f.pts.length - 1];
    f.seen = Math.max(f.seen, f.start, f.end, lastPt ? lastPt[0] : 0);
    f.v++;
  }
  const latest = () => Object.values(flights).filter((f) => f.start || f.pts.length).sort((x, y) => y.seen - x.seen)[0];

  // One track from both sources: transponder points, plus phone points only where the transponder has a gap.
  // Transponder points carry a 7th element 'a' so the panel can say where the position came from.
  function track(f) {
    if (f.mv === f.v) return f.merged;
    const ad = f.adsb.filter((q) => q[0] >= f.start - 60 && (!f.end || q[0] <= f.end + 60));
    const ts = ad.map((q) => q[0]);
    const gap = (t) => {
      let lo = 0, hi = ts.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] < t) lo = m + 1; else hi = m; }
      return Math.min(Math.abs(ts[lo] - t), lo ? Math.abs(ts[lo - 1] - t) : Infinity);
    };
    const phone = ts.length ? f.pts.filter((q) => gap(q[0]) > 30) : f.pts;
    f.merged = [...ad.map((q) => [...q.slice(0, 6), 'a']), ...phone].sort((x, y) => x[0] - y[0]);
    f.mv = f.v;
    return f.merged;
  }
  const lastSeen = (f) => Math.max(f.seen, f.adsb.length ? f.adsb[f.adsb.length - 1][0] : 0);

  function statusOf(f) {
    if (f.end) return 'landed';
    const lastA = f.adsb.length ? f.adsb[f.adsb.length - 1][0] : 0;
    if (now() - lastA < ADSB_FRESH) return 'live';
    return now() - f.seen > (f.iv || 30) * 2.5 + 20 ? 'stale' : 'live';
  }

  // Pull transponder data for the current flight from the server.
  async function pollAdsb() {
    const f = latest();
    if (!f || !f.tail || !f.start || now() - f.start > 8 * 3600) return;
    if (f.end && f.adsbDone) return;
    const lastA = f.adsb[f.adsb.length - 1];
    const r = await apiGet(adsbUrl(f.tail, lastA ? lastA[0] : f.start - 60));
    apiOk = !!r;
    if (!r) return;
    for (const q of r.track || []) if (!f.adsb.length || q[0] > f.adsb[f.adsb.length - 1][0]) f.adsb.push(q);
    f.ac = r.ac;
    if (f.end) f.adsbDone = true;
    f.v++;
    schedule();
  }

  async function pollWatchTraffic() {
    const f = latest();
    if (!f || !f.tail || !f.ac || !f.ac.visible) {
      watchTraffic = { nearest: null, all: [] };
      updateWatchTrafficMarkers();
      return;
    }
    
    const r = await apiGet(`/traffic/${encodeURIComponent(f.tail)}`);
    if (r) {
      watchTraffic.nearest = r.nearest;
      watchTraffic.all = r.traffic || [];
      updateWatchTrafficMarkers();
    }
  }
  
  function updateWatchTrafficMarkers() {
    // Clear old markers
    trafficMarkers.forEach(m => map.removeLayer(m));
    trafficMarkers = [];
    if (nearestLine) { map.removeLayer(nearestLine); nearestLine = null; }
    
    const f = latest();
    if (!watchTraffic.all.length || !f || !f.ac) return;
    
    // Draw nearest with dashed line
    if (watchTraffic.nearest) {
      const n = watchTraffic.nearest;
      nearestLine = L.polyline([
        [f.ac.lat, f.ac.lon],
        [n.lat, n.lon]
      ], { color: '#f59e0b', weight: 2, dashArray: '5, 5', opacity: 0.6 }).addTo(map);
      
      const icon = planeIcon('#f59e0b', n.trk, true);
      const m = L.marker([n.lat, n.lon], { icon, interactive: false, zIndexOffset: 500 }).addTo(map);
      trafficMarkers.push(m);
    }
    
    // Draw other traffic as faint icons
    watchTraffic.all.slice(1, 10).forEach((t) => {
      const icon = planeIcon('#999', t.trk, false);
      const m = L.marker([t.lat, t.lon], { icon, interactive: false, zIndexOffset: 100, opacity: 0.4 }).addTo(map);
      trafficMarkers.push(m);
    });
  }

  function drawMap() {
    const f = latest();
    const pts = f ? track(f) : [];
    if (!pts.length) return;
    const color = f.color || COLORS[0];
    const lls = pts.map((q) => [q[1], q[2]]);
    
    // Smooth the trail
    const smoothLls = lls.length > 2 ? smoothPolyline(lls, 8) : lls;
    
    const lastPt = pts[pts.length - 1];
    const here = [lastPt[1], lastPt[2]];
    const st = statusOf(f);
    trail.setStyle({ color });
    trail.setLatLngs(smoothLls);
    const icon = planeIcon(color, lastPt[5], st === 'live');
    
    // Update dead-reckoning state with actual fix time
    const fixTime = lastPt[0] * 1000; // Convert to milliseconds
    const fixId = `${lastPt[0]}-${lastPt[1]}-${lastPt[2]}`;
    
    // Only update if this is a new fix
    if (fixId !== lastFix?.id) {
      lastFix = { lat: here[0], lon: here[1], trk: lastPt[5], gs: lastPt[4] || 0, id: fixId };
      lastFixTime = fixTime;
    }
    
    if (!marker) {
      marker = L.marker(here, { icon, interactive: false, zIndexOffset: 1000 }).addTo(map);
    } else {
      marker.setLatLng(here);
      marker.setIcon(icon);
    }
    
    if (!startMarker) startMarker = L.marker(lls[0], { icon: dotIcon(color), interactive: false }).addTo(map);
    else startMarker.setLatLng(lls[0]);

    if (!fitted) {
      fitted = true;
      if (st === 'landed' || lls.length > 1) map.fitBounds(trail.getBounds(), { paddingTopLeft: [40, 90], paddingBottomRight: [40, 280], maxZoom: 13 });
      else map.setView(here, 12);
    } else if (follow && st !== 'landed') {
      map.panTo(here, { animate: true });
    }
  }

  function renderPanel() {
    const f = latest();
    let html;
    if (!f) {
      const who = nameHint || 'This pilot';
      html = `
        <div class="panel-head">
          <div class="avatar">${esc((nameHint || '?')[0].toUpperCase())}</div>
          <div class="who"><b>${esc(who)}</b><span class="status idle"><i></i>${connected ? 'Not flying' : 'Connecting…'}</span></div>
        </div>
        <p class="muted" style="margin-top:14px;font-size:15px">No flights in the last 12 hours. Turn on alerts to get a notification the moment ${esc(nameHint || 'they')} start${nameHint ? 's' : ''} a flight.</p>
        <a class="btn btn-primary btn-block" style="margin-top:14px" href="#/follow/${esc(ch)}/${encodeURIComponent(nameHint)}">${I.bell}Get flight alerts</a>`;
    } else {
      const st = statusOf(f);
      const pts = track(f);
      const pt = pts[pts.length - 1];
      const seen = lastSeen(f);
      const label = { live: 'Live', stale: 'Signal lost', landed: 'Landed' }[st];
      const dist = pts.reduce((s, q, i) => (i ? s + nmBetween([pts[i - 1][1], pts[i - 1][2]], [q[1], q[2]]) : 0), 0);
      const dur = (f.end || (st === 'live' ? now() : seen)) - (f.start || pts[0]?.[0] || seen);
      const via = pt ? (pt[6] === 'a' ? ' · via transponder' : ' · via phone GPS') : '';
      const foot = st === 'landed'
        ? `Landed at ${fmtTime(f.end)} · ${fmtHrs(dur)}`
        : st === 'stale'
          ? `Last position ${ago(seen)}${via}`
          : pt ? `Updated ${ago(pt[0])}${via}` : 'Started — waiting for first position';
      html = `
        <div class="panel-head">
          <div class="avatar" style="--c:${f.color || COLORS[0]}">${esc((f.name || nameHint || '?')[0].toUpperCase())}</div>
          <div class="who"><b>${esc(f.name || nameHint || 'Pilot')}</b><span><span class="mono">${esc(f.tail || '')}</span>${f.type ? ' · ' + esc(f.type) : ''}</span></div>
          <span class="status ${st}"><i></i>${label}</span>
        </div>
        <div class="stats">
          <div class="stat"><small>Alt</small><b>${pt?.[6] === 'a' && pt[3] === 0 ? 'GND' : pt?.[3] != null ? Math.round(pt[3]).toLocaleString() + '<u>ft</u>' : '—'}</b></div>
          <div class="stat"><small>Speed</small><b>${pt?.[4] != null ? pt[4] + '<u>kt</u>' : '—'}</b></div>
          <div class="stat"><small>Hdg</small><b>${pt?.[5] != null ? fmtHdg(pt[5]) + '°' : '—'}</b></div>
          <div class="stat"><small>Time</small><b>${fmtDur(dur).replace(/:\d\d$/, (m) => (dur >= 3600 ? '' : m))}</b></div>
        </div>
        ${watchTraffic.nearest ? `<div style="margin:8px 0;padding:8px;background:rgba(0,0,0,0.05);border-radius:8px;font-size:13px;">
          <div style="font-weight:600;margin-bottom:4px;">Nearest Traffic</div>
          <div style="color:#666;"><b>${esc(watchTraffic.nearest.callsign || watchTraffic.nearest.tail || 'Unknown')}</b> ${watchTraffic.nearest.dist.toFixed(1)} nm, ${watchTraffic.nearest.clock ? watchTraffic.nearest.clock + ' o\'clock' : watchTraffic.nearest.cardinal}, ${watchTraffic.nearest.relAlt > 0 ? '+' : ''}${Math.round(watchTraffic.nearest.relAlt)} ft${watchTraffic.nearest.vs > 100 ? ' ↑' : watchTraffic.nearest.vs < -100 ? ' ↓' : ''}</div>
        </div>` : st === 'live' ? `<div style="margin:8px 0;padding:8px;background:rgba(0,0,0,0.05);border-radius:8px;font-size:13px;color:#999;">No traffic within 10 nm</div>` : ''}
        <div class="panel-foot"><span>${foot}</span><span>${dist.toFixed(dist < 10 ? 1 : 0)} nm flown</span></div>
        ${connected ? '' : `<div class="banner">${I.alert}<span>Reconnecting…</span></div>`}`;
    }
    if (html !== lastHtml) { $('#panel').innerHTML = html; lastHtml = html; }
  }

  let pending = null;
  const schedule = () => {
    if (pending) return;
    pending = setTimeout(() => { pending = null; drawMap(); renderPanel(); }, 250);
  };

  const es = new EventSource(`${NTFY}/${dataTopic(ch)}/sse?since=${HISTORY}`);
  es.onopen = () => { connected = true; schedule(); };
  es.onerror = () => { connected = false; schedule(); };
  es.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.event !== 'message' || seen.has(m.id)) return;
    seen.add(m.id);
    try { ingest(JSON.parse(m.message)); } catch {}
    schedule();
  };
  const tick = setInterval(() => { renderPanel(); }, 1000);
  let adsbBusy = false;
  const adsbTick = async () => {
    if (adsbBusy) return;
    adsbBusy = true;
    try { await pollAdsb(); } finally { adsbBusy = false; }
  };
  const adsbTimer = setInterval(adsbTick, 1000);
  const adsbFirst = setTimeout(adsbTick, 1500); // after the ntfy backlog tells us the tail number
  
  // Poll traffic every 3 seconds
  pollWatchTraffic();
  const trafficTimer = setInterval(pollWatchTraffic, 3000);
  
  cleanup.push(() => { 
    es.close(); 
    clearInterval(tick); 
    clearInterval(adsbTimer); 
    clearInterval(trafficTimer);
    clearTimeout(adsbFirst); 
    clearTimeout(pending); 
  });
  renderPanel();
}

/* ---------- Follow / invite page (watcher) ---------- */
function viewFollow(ch, name) {
  const who = name || 'this pilot';
  const topic = alertTopic(ch);
  const live = `${baseUrl()}#/track/${ch}/${encodeURIComponent(name)}`;
  
  // In native app, show simplified follow flow
  if (isNative) {
    const myProfile = profile();
    const myChannel = myProfile ? myProfile.channel : rid(16);
    if (!myProfile) {
      saveProfile({ name: 'Watcher', channel: myChannel, interval: 30, demo: false, watcherMode: true });
    }
    
    app.innerHTML = `
      <header class="topbar">
        <a class="icon-btn" href="#/" aria-label="Back">${I.back}</a>
        <div class="brand"><img src="icons/icon.svg" alt="">Contrail</div>
        <span style="width:40px"></span>
      </header>
      <main class="page">
        <section class="hero">
          <p class="eyebrow">You're invited</p>
          <h1>Follow ${esc(who)}'s flights</h1>
          <p>Get a notification when ${esc(who)} starts a flight and when they land, then watch the whole flight live.</p>
        </section>
        <section>
          <button class="btn btn-primary btn-lg btn-block" id="follow-btn">${I.bell}Follow ${esc(who)}</button>
          <p class="hint" style="margin-top:12px;text-align:center">You'll get push notifications on this device when they fly.</p>
        </section>
        <section>
          <a class="btn btn-block" href="${esc(live)}">${I.map}View live map</a>
        </section>
      </main>`;
    
    $('#follow-btn').onclick = async () => {
      const btn = $('#follow-btn');
      btn.disabled = true;
      btn.textContent = 'Following...';
      
      try {
        const res = await fetch(`${API}/follow`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pilotChannel: ch, followerChannel: myChannel }),
        });
        
        if (res.ok) {
          // Re-register device to ensure we're registered
          if (pushToken) {
            await fetch(`${API}/device/register`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ channel: myChannel, token: pushToken, platform: 'ios' }),
            });
          }
          
          toast(`Following ${who}!`);
          btn.innerHTML = `${I.check}Following`;
          setTimeout(() => {
            location.hash = `#/track/${ch}/${encodeURIComponent(name)}`;
          }, 1000);
        } else {
          throw new Error('Follow failed');
        }
      } catch (err) {
        console.error('Follow error:', err);
        toast('Failed to follow. Try again.');
        btn.disabled = false;
        btn.innerHTML = `${I.bell}Follow ${esc(who)}`;
      }
    };
    
    return;
  }
  
  // Web version: show ntfy instructions
  app.innerHTML = `
    <header class="topbar"><div class="brand"><img src="icons/icon.svg" alt="">Contrail</div></header>
    <main class="page">
      <section class="hero">
        <p class="eyebrow">You’re invited</p>
        <h1>Follow ${esc(who)}’s flights</h1>
        <p>Get a notification when ${esc(who)} starts a flight and when they land, then watch the whole flight live on a map.</p>
      </section>
      <section class="steps">
        <div class="card step">
          <h3>Get the free ntfy app</h3>
          <p>ntfy delivers Contrail’s notifications. No account or sign-up needed.</p>
          <div class="btn-row">
            <a class="btn" href="https://apps.apple.com/app/ntfy/id1625396347" target="_blank" rel="noopener">iPhone</a>
            <a class="btn" href="https://play.google.com/store/apps/details?id=io.heckel.ntfy" target="_blank" rel="noopener">Android</a>
          </div>
        </div>
        <div class="card step">
          <h3>Subscribe to ${esc(who)}’s alerts</h3>
          <p>In ntfy, tap <b>+</b> and paste this topic name (leave the server as ntfy.sh):</p>
          <div class="code"><span>${esc(topic)}</span><button id="copy">Copy</button></div>
          <a class="btn btn-block" href="ntfy://ntfy.sh/${esc(topic)}">Open in ntfy</a>
        </div>
        <div class="card step">
          <h3>That’s it</h3>
          <p>Tap any Contrail notification to jump straight to the live map. You can also open it any time:</p>
          <a class="btn btn-primary btn-block" href="${esc(live)}">${I.map}Open live map</a>
        </div>
      </section>
      <section class="muted" style="font-size:14px;text-align:center">
        On a computer? Open <a href="https://ntfy.sh/${esc(topic)}" target="_blank" rel="noopener">ntfy.sh/${esc(topic)}</a> and allow notifications.
      </section>
    </main>`;
  $('#copy').onclick = () => copy(topic, 'Topic copied');
}

/* ---------- Settings ---------- */
function viewSettings() {
  const p = profile();
  const row = (label, desc, control) => `<div class="setting"><div><div class="label">${label}</div>${desc ? `<div class="desc">${desc}</div>` : ''}</div>${control}</div>`;
  app.innerHTML = `
    <header class="topbar">
      <a class="icon-btn" href="#/" aria-label="Back">${I.back}</a>
      <div class="brand">Settings</div>
      <span style="width:40px"></span>
    </header>
    <main class="page">
      <section>
        <div class="field"><label for="name">Your name</label><input class="input" id="name" maxlength="24" value="${esc(p.name)}"></div>
        <div class="field"><label>Position updates</label>
          <div class="seg" id="iv">${[15, 30, 60].map((s) => `<button data-s="${s}" class="${(p.interval || 30) === s ? 'is-on' : ''}">Every ${s}s</button>`).join('')}</div>
          <p class="hint">ntfy.sh’s free tier allows about 250 messages a day. Every 30s uses ~120 per flight hour.</p>
        </div>
      </section>
      <section class="list">
        ${row('Phone GPS backup', 'Your transponder is tracked automatically. Also sending phone GPS fills gaps where receivers can’t see you (low in the pattern), but needs Contrail open with the screen on.', `<button class="switch ${p.gps !== false ? 'is-on' : ''}" id="gps" role="switch" aria-checked="${p.gps !== false}" aria-label="Phone GPS backup"></button>`)}
        ${row('Demo mode', 'Simulate a flight near Martin State (KMTN) instead of using GPS. Great for showing your people how it works.', `<button class="switch ${p.demo ? 'is-on' : ''}" id="demo" role="switch" aria-checked="${!!p.demo}" aria-label="Demo mode"></button>`)}
      </section>
      <section class="card watch-card">
        <div class="row"><div class="glyph">${I.users}</div><div><h3>Invite link</h3><p>Anyone with this link can set up alerts and watch your flights.</p></div></div>
        <div class="code"><span>${esc(followUrl(p))}</span><button id="copy">Copy</button></div>
        <button class="btn btn-block" id="reset" style="color:var(--danger)">Make a new private link</button>
        <p class="hint" style="margin:0">Old links and alert subscriptions stop working. Use this if a link was shared with the wrong person.</p>
      </section>
      <section class="list">
        ${row('Flight log', `${store.get('log', []).length} flights saved on this phone`, '<button class="btn" id="clear">Clear</button>')}
      </section>
    </main>`;

  $('#name').onchange = (e) => { const v = e.target.value.trim(); if (v) { saveProfile({ ...profile(), name: v }); toast('Saved'); } };
  $('#iv').onclick = (e) => {
    const b = e.target.closest('[data-s]');
    if (!b) return;
    saveProfile({ ...profile(), interval: +b.dataset.s });
    document.querySelectorAll('#iv button').forEach((x) => x.classList.toggle('is-on', x === b));
  };
  $('#demo').onclick = (e) => {
    const on = !profile().demo;
    saveProfile({ ...profile(), demo: on });
    e.currentTarget.classList.toggle('is-on', on);
    e.currentTarget.setAttribute('aria-checked', on);
    toast(on ? 'Demo mode on' : 'Demo mode off');
  };
  $('#gps').onclick = (e) => {
    const on = profile().gps === false;
    saveProfile({ ...profile(), gps: on });
    e.currentTarget.classList.toggle('is-on', on);
    e.currentTarget.setAttribute('aria-checked', on);
    toast(on ? 'Phone GPS backup on' : 'Transponder only');
  };
  $('#copy').onclick = () => copy(followUrl(profile()), 'Invite link copied');
  $('#reset').onclick = async () => {
    const ok = await confirmSheet({ title: 'New private link?', lead: 'Everyone will need your new invite link to keep following your flights.', ok: 'Make new link', danger: true });
    if (ok) { saveProfile({ ...profile(), channel: rid(16) }); route(); toast('New link created'); }
  };
  $('#clear').onclick = async () => {
    const ok = await confirmSheet({ title: 'Clear flight log?', lead: 'This removes all saved flights from this phone.', ok: 'Clear log', danger: true });
    if (ok) { store.set('log', []); route(); }
  };
}

/* ---------- Boot ---------- */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
route();

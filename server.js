'use strict';

/* =========================================================================
   Contrail server — serves the app and relays ADS-B (transponder) data.
   Browsers can't call the public ADS-B feeds directly (no CORS), so this
   polls them by tail number and keeps a short in-memory track per aircraft.
   No dependencies; Node 18+.
   ========================================================================= */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const SELF_URL = process.env.RENDER_EXTERNAL_URL; // set automatically on Render
const POLL_MS = 5000;              // how often each active tail is polled
const MIN_STEP = 4;                // seconds between stored track points
const KEEP_SEC = 8 * 3600;         // how much track history to keep in memory
const PILOT_TTL = 5 * 3600;        // a started flight is polled for up to 5 h unless ended
const WATCH_TTL = 10 * 60;         // a watcher keeps a tail polled for 10 min after its last request
const MAX_TAILS = 100;
const UA = 'contrail-flight-tracker (+https://github.com/ryanjbusker/Tracking-App)';
const FEEDS = [
  (reg) => `https://api.adsb.lol/v2/reg/${reg}`,
  (reg) => `https://opendata.adsb.fi/api/v2/registration/${reg}`,
];

const TAIL_RE = /^[A-Z0-9-]{2,8}$/;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/plain; charset=utf-8',
};
const PUBLIC = new Set(['/index.html', '/app.js', '/styles.css', '/sw.js', '/manifest.webmanifest']);

const now = () => Math.floor(Date.now() / 1000);
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

/* ---------- ADS-B tracking ---------- */
// tail -> { activeUntil, track: [[t, lat, lon, alt, gs, trk]], ac, lastPoll, feedOk }
const tails = new Map();

function entry(tail) {
  let e = tails.get(tail);
  if (!e) {
    if (tails.size >= MAX_TAILS) {
      const oldest = [...tails].sort((a, b) => a[1].activeUntil - b[1].activeUntil)[0];
      tails.delete(oldest[0]);
    }
    e = { activeUntil: 0, track: [], ac: null, lastPoll: 0, feedOk: null };
    tails.set(tail, e);
  }
  return e;
}

async function fetchFeed(tail) {
  for (const url of FEEDS) {
    try {
      const res = await fetch(url(tail), { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      return await res.json();
    } catch {}
  }
  return null;
}

async function poll(tail) {
  const e = entry(tail);
  e.lastPoll = now();
  const data = await fetchFeed(tail);
  e.feedOk = !!data;
  if (!data) return;
  const list = Array.isArray(data.ac) ? data.ac : [];
  const ac = list.find((a) => (a.r || '').toUpperCase() === tail) || list[0];
  if (!ac || num(ac.lat) == null || num(ac.lon) == null) { if (e.ac) e.ac.visible = false; return; }

  const feedNow = num(data.now) ? data.now / 1000 : Date.now() / 1000;
  const t = Math.round(feedNow - (num(ac.seen_pos) ?? num(ac.seen) ?? 0));
  const ground = ac.alt_baro === 'ground';
  const alt = ground ? 0 : num(ac.alt_baro) ?? num(ac.alt_geom);
  const gs = num(ac.gs), trk = num(ac.track) ?? num(ac.true_heading);
  e.ac = {
    visible: now() - t < 60,
    hex: ac.hex, type: ac.t || null, desc: ac.desc || null, squawk: ac.squawk || null,
    t, lat: ac.lat, lon: ac.lon, alt, ground, gs, trk,
  };
  const last = e.track[e.track.length - 1];
  if (!last || t - last[0] >= MIN_STEP) {
    e.track.push([t, +ac.lat.toFixed(5), +ac.lon.toFixed(5), alt == null ? null : Math.round(alt), gs == null ? null : Math.round(gs), trk == null ? null : Math.round(trk)]);
  }
  const cutoff = now() - KEEP_SEC;
  while (e.track.length && e.track[0][0] < cutoff) e.track.shift();
}

let polling = false;
setInterval(async () => {
  if (polling) return;
  polling = true;
  const t = now();
  const active = [...tails].filter(([, e]) => e.activeUntil > t && t - e.lastPoll >= POLL_MS / 1000 - 1).map(([k]) => k);
  await Promise.all(active.map(poll));
  polling = false;
}, POLL_MS);

// Render's free tier sleeps after ~15 min without inbound traffic; ping ourselves while a flight is active.
if (SELF_URL) {
  setInterval(() => {
    if ([...tails.values()].some((e) => e.activeUntil > now())) fetch(`${SELF_URL}/healthz`).catch(() => {});
  }, 8 * 60 * 1000);
}

/* ---------- HTTP ---------- */
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json' });

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 2000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

  // GET /api/ac/:tail?since=unix -> current position + track since `since`
  if (req.method === 'GET' && parts[1] === 'ac' && parts[2]) {
    const tail = decodeURIComponent(parts[2]).toUpperCase();
    if (!TAIL_RE.test(tail)) return json(res, 400, { error: 'bad tail' });
    const e = entry(tail);
    e.activeUntil = Math.max(e.activeUntil, now() + WATCH_TTL);
    if (now() - e.lastPoll >= POLL_MS / 1000) await poll(tail);
    const since = Number(url.searchParams.get('since')) || 0;
    return json(res, 200, { tail, ac: e.ac, track: e.track.filter((p) => p[0] > since), feedOk: e.feedOk, polledAt: e.lastPoll });
  }

  // POST /api/track {tail}  — pilot started a flight
  // POST /api/track/end {tail} — pilot ended it
  if (req.method === 'POST' && parts[1] === 'track') {
    const body = await readBody(req);
    const tail = String(body.tail || '').toUpperCase();
    if (!TAIL_RE.test(tail)) return json(res, 400, { error: 'bad tail' });
    const e = entry(tail);
    if (parts[2] === 'end') e.activeUntil = now() + 60;
    else { e.activeUntil = Math.max(e.activeUntil, now() + PILOT_TTL); if (now() - e.lastPoll > 2) poll(tail); }
    return json(res, 200, { ok: true });
  }

  if (req.method === 'OPTIONS') {
    return send(res, 204, '', { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type' });
  }
  return json(res, 404, { error: 'not found' });
}

function serveStatic(req, res, url) {
  let p = path.posix.normalize(decodeURIComponent(url.pathname));
  if (p === '/') p = '/index.html';
  if (!PUBLIC.has(p) && !p.startsWith('/icons/')) return send(res, 404, 'Not found');
  const file = path.join(ROOT, path.normalize(p));
  if (!file.startsWith(ROOT)) return send(res, 404, 'Not found');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    const ext = path.extname(file);
    send(res, 200, data, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': p.startsWith('/icons/') ? 'public, max-age=86400' : 'no-cache',
    });
  });
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/healthz') return send(res, 200, 'ok');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, '');
    serveStatic(req, res, url);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, 'error');
  }
}).listen(PORT, () => console.log(`Contrail on :${PORT}`));

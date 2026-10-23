'use strict';

/* =========================================================================
   Contrail server — serves the app and relays ADS-B (transponder) data.
   Browsers can't call the public ADS-B feeds directly (no CORS), so this
   polls them by tail number and keeps a short in-memory track per aircraft.
   
   v2: Native mobile app support with PostgreSQL and Firebase Cloud Messaging
   ========================================================================= */

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const pg = require('pg');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const SELF_URL = process.env.RENDER_EXTERNAL_URL; // set automatically on Render
const DATABASE_URL = process.env.DATABASE_URL;
const FCM_SERVER_KEY = process.env.FCM_SERVER_KEY; // Firebase Cloud Messaging server key
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

/* ---------- Database ---------- */
let db = null;
if (DATABASE_URL) {
  const isLocal = DATABASE_URL.includes('localhost') || DATABASE_URL.includes('127.0.0.1');
  const sslConfig = isLocal ? false : { rejectUnauthorized: false };
  db = new pg.Pool({ connectionString: DATABASE_URL, ssl: sslConfig, max: 10 });
  db.on('error', (err) => console.error('Database pool error:', err));
  console.log('Database connected');
} else {
  console.warn('WARNING: DATABASE_URL not set — native push notifications disabled');
}

/* ---------- Firebase Cloud Messaging ---------- */
async function sendPush(tokens, notification) {
  if (!FCM_SERVER_KEY) {
    console.warn('FCM_SERVER_KEY not set, skipping push');
    return { success: 0, failed: tokens.length };
  }
  
  const payload = JSON.stringify({
    registration_ids: tokens,
    notification: {
      title: notification.title,
      body: notification.body,
      sound: 'default',
      badge: 1,
    },
    data: notification.data || {},
    priority: 'high',
  });

  return new Promise((resolve) => {
    const req = https.request('https://fcm.googleapis.com/fcm/send', {
      method: 'POST',
      headers: {
        'Authorization': `key=${FCM_SERVER_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve({ success: result.success || 0, failed: result.failure || 0 });
        } catch {
          resolve({ success: 0, failed: tokens.length });
        }
      });
    });
    req.on('error', () => resolve({ success: 0, failed: tokens.length }));
    req.write(payload);
    req.end();
  });
}

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

  // POST /api/device/register {channel, token, platform} — register device for push
  if (req.method === 'POST' && parts[1] === 'device' && parts[2] === 'register') {
    if (!db) return json(res, 503, { error: 'database not available' });
    const body = await readBody(req);
    const { channel, token, platform } = body;
    if (!channel || !token || !platform) return json(res, 400, { error: 'missing required fields' });
    if (!/^[a-z0-9]{8,32}$/i.test(channel)) return json(res, 400, { error: 'invalid channel' });
    if (!['ios', 'android', 'web'].includes(platform)) return json(res, 400, { error: 'invalid platform' });
    try {
      await db.query(
        `INSERT INTO devices (channel, token, platform, last_seen)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (token) DO UPDATE SET channel = $1, last_seen = NOW()`,
        [channel, token, platform]
      );
      return json(res, 200, { ok: true });
    } catch (err) {
      console.error('Device registration failed:', err);
      return json(res, 500, { error: 'database error' });
    }
  }

  // POST /api/follow {pilotChannel, followerChannel} — follow a pilot
  if (req.method === 'POST' && parts[1] === 'follow') {
    if (!db) return json(res, 503, { error: 'database not available' });
    const body = await readBody(req);
    const { pilotChannel, followerChannel } = body;
    if (!pilotChannel || !followerChannel) return json(res, 400, { error: 'missing required fields' });
    if (!/^[a-z0-9]{8,32}$/i.test(pilotChannel) || !/^[a-z0-9]{8,32}$/i.test(followerChannel)) {
      return json(res, 400, { error: 'invalid channel format' });
    }
    try {
      await db.query(
        `INSERT INTO followers (pilot_channel, follower_channel)
         VALUES ($1, $2)
         ON CONFLICT (pilot_channel, follower_channel) DO NOTHING`,
        [pilotChannel, followerChannel]
      );
      return json(res, 200, { ok: true });
    } catch (err) {
      console.error('Follow failed:', err);
      return json(res, 500, { error: 'database error' });
    }
  }

  // GET /api/following/:channel — get pilots this user is following
  if (req.method === 'GET' && parts[1] === 'following' && parts[2]) {
    if (!db) return json(res, 503, { error: 'database not available' });
    const channel = decodeURIComponent(parts[2]);
    if (!/^[a-z0-9]{8,32}$/i.test(channel)) return json(res, 400, { error: 'invalid channel' });
    try {
      const result = await db.query(
        'SELECT pilot_channel, created_at FROM followers WHERE follower_channel = $1',
        [channel]
      );
      return json(res, 200, { following: result.rows });
    } catch (err) {
      console.error('Get following failed:', err);
      return json(res, 500, { error: 'database error' });
    }
  }

  // POST /api/push/test {channel} — send test push (dev only)
  if (req.method === 'POST' && parts[1] === 'push' && parts[2] === 'test') {
    if (!db) return json(res, 503, { error: 'database not available' });
    const body = await readBody(req);
    const { channel } = body;
    if (!channel) return json(res, 400, { error: 'missing channel' });
    try {
      const result = await db.query('SELECT token FROM devices WHERE channel = $1', [channel]);
      if (result.rows.length === 0) return json(res, 200, { sent: 0, message: 'no devices' });
      const tokens = result.rows.map((r) => r.token);
      const pushResult = await sendPush(tokens, {
        title: 'Contrail Test',
        body: 'Push notifications are working!',
        data: { type: 'test' },
      });
      return json(res, 200, { sent: pushResult.success, failed: pushResult.failed, devices: tokens.length });
    } catch (err) {
      console.error('Test push failed:', err);
      return json(res, 500, { error: 'push failed' });
    }
  }

  // POST /api/flight/start {channel, tail, pilotName, type} — pilot started, send pushes to followers
  if (req.method === 'POST' && parts[1] === 'flight' && parts[2] === 'start') {
    if (!db) return json(res, 503, { error: 'database not available' });
    const body = await readBody(req);
    const { channel, tail, pilotName, type } = body;
    if (!channel || !tail) return json(res, 400, { error: 'missing required fields' });
    try {
      // Log the event
      await db.query(
        `INSERT INTO flight_events (channel, event_type, tail, pilot_name, data)
         VALUES ($1, 'start', $2, $3, $4)`,
        [channel, tail, pilotName, JSON.stringify({ type })]
      );
      
      // Get follower devices
      const result = await db.query(
        `SELECT DISTINCT d.token 
         FROM followers f 
         JOIN devices d ON f.follower_channel = d.channel 
         WHERE f.pilot_channel = $1`,
        [channel]
      );
      
      if (result.rows.length > 0) {
        const tokens = result.rows.map((r) => r.token);
        const trackUrl = SELF_URL ? `${SELF_URL}#/track/${channel}/${encodeURIComponent(pilotName || 'Pilot')}` : '';
        await sendPush(tokens, {
          title: `${pilotName || 'A pilot'} started a flight`,
          body: `${tail}${type ? ' · ' + type : ''} — tap to follow along live.`,
          data: { type: 'flight_start', channel, url: trackUrl },
        });
      }
      
      return json(res, 200, { ok: true, notified: result.rows.length });
    } catch (err) {
      console.error('Flight start notification failed:', err);
      return json(res, 500, { error: 'notification failed' });
    }
  }

  // POST /api/flight/end {channel, tail, pilotName, duration, distance} — pilot landed
  if (req.method === 'POST' && parts[1] === 'flight' && parts[2] === 'end') {
    if (!db) return json(res, 503, { error: 'database not available' });
    const body = await readBody(req);
    const { channel, tail, pilotName, duration, distance } = body;
    if (!channel || !tail) return json(res, 400, { error: 'missing required fields' });
    try {
      // Log the event
      await db.query(
        `INSERT INTO flight_events (channel, event_type, tail, pilot_name, data)
         VALUES ($1, 'end', $2, $3, $4)`,
        [channel, tail, pilotName, JSON.stringify({ duration, distance })]
      );
      
      // Get follower devices
      const result = await db.query(
        `SELECT DISTINCT d.token 
         FROM followers f 
         JOIN devices d ON f.follower_channel = d.channel 
         WHERE f.pilot_channel = $1`,
        [channel]
      );
      
      if (result.rows.length > 0) {
        const tokens = result.rows.map((r) => r.token);
        const durationStr = duration ? `${(duration / 3600).toFixed(1)} h` : '';
        const distanceStr = distance && distance >= 1 ? `, ${Math.round(distance)} nm` : '';
        const trackUrl = SELF_URL ? `${SELF_URL}#/track/${channel}/${encodeURIComponent(pilotName || 'Pilot')}` : '';
        await sendPush(tokens, {
          title: `${pilotName || 'Pilot'} has landed`,
          body: `${tail}${durationStr ? ' · ' + durationStr + ' flight' + distanceStr : ''}.`,
          data: { type: 'flight_end', channel, url: trackUrl },
        });
      }
      
      return json(res, 200, { ok: true, notified: result.rows.length });
    } catch (err) {
      console.error('Flight end notification failed:', err);
      return json(res, 500, { error: 'notification failed' });
    }
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

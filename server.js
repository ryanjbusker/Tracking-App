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
const APNS_KEY_ID = process.env.APNS_KEY_ID;
const APNS_TEAM_ID = process.env.APNS_TEAM_ID;
const APNS_BUNDLE_ID = process.env.APNS_BUNDLE_ID;
const APNS_KEY = process.env.APNS_KEY; // .p8 file contents
const APNS_ENV = process.env.APNS_ENV || 'production'; // 'sandbox' or 'production'
const POLL_MS = 1000;              // how often each active tail is polled (Flightradar-like)
const CACHE_MS = 800;              // cache feed results to avoid hammering APIs
const MIN_STEP = 0;                // store every point when position changes
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

/* ---------- Database Migration ---------- */
const MIGRATION_SQL = `
-- Device tokens for push notifications (iOS only)
CREATE TABLE IF NOT EXISTS devices (
  id SERIAL PRIMARY KEY,
  channel VARCHAR(32) NOT NULL,
  token TEXT NOT NULL UNIQUE,
  platform VARCHAR(10) NOT NULL CHECK (platform = 'ios'),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_devices_channel ON devices(channel);
CREATE INDEX IF NOT EXISTS idx_devices_token ON devices(token);

-- Follower relationships (pilot channel -> follower channel)
CREATE TABLE IF NOT EXISTS followers (
  id SERIAL PRIMARY KEY,
  pilot_channel VARCHAR(32) NOT NULL,
  follower_channel VARCHAR(32) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(pilot_channel, follower_channel)
);

CREATE INDEX IF NOT EXISTS idx_followers_pilot ON followers(pilot_channel);
CREATE INDEX IF NOT EXISTS idx_followers_follower ON followers(follower_channel);

-- Flight events log (for debugging and history)
CREATE TABLE IF NOT EXISTS flight_events (
  id SERIAL PRIMARY KEY,
  channel VARCHAR(32) NOT NULL,
  event_type VARCHAR(20) NOT NULL CHECK (event_type IN ('start', 'end')),
  tail VARCHAR(10),
  pilot_name VARCHAR(50),
  data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_flight_events_channel ON flight_events(channel);
CREATE INDEX IF NOT EXISTS idx_flight_events_created ON flight_events(created_at);
`;

async function runMigration(retries = 3) {
  if (!db) {
    console.log('Skipping migration: DATABASE_URL not set');
    return;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`Running database migration (attempt ${attempt}/${retries})...`);
      await db.query(MIGRATION_SQL);
      console.log('✓ Migration complete: devices, followers, flight_events tables ready');
      return;
    } catch (err) {
      console.error(`Migration attempt ${attempt} failed:`, err.message);
      if (attempt < retries) {
        const delay = attempt * 1000; // 1s, 2s, 3s
        console.log(`Retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        console.error('⚠ Migration failed after all retries. Server will continue but database features may not work.');
        console.error('⚠ Check DATABASE_URL and database connectivity.');
      }
    }
  }
}

// Run migration on startup (non-blocking)
if (db) {
  runMigration().catch((err) => console.error('Migration error:', err));
}

/* ---------- Apple Push Notification Service (APNs) ---------- */
const http2 = require('node:http2');
const crypto = require('node:crypto');

let apnsJwt = null;
let apnsJwtExpiry = 0;

function generateApnsJwt() {
  if (!APNS_KEY_ID || !APNS_TEAM_ID || !APNS_KEY) return null;
  
  const now = Math.floor(Date.now() / 1000);
  if (apnsJwt && apnsJwtExpiry > now + 300) return apnsJwt; // reuse if >5 min left
  
  const header = { alg: 'ES256', kid: APNS_KEY_ID };
  const payload = { iss: APNS_TEAM_ID, iat: now };
  
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const token = `${encode(header)}.${encode(payload)}`;
  
  const sign = crypto.createSign('sha256');
  sign.update(token);
  sign.end();
  const signature = sign.sign(APNS_KEY, 'base64url');
  
  apnsJwt = `${token}.${signature}`;
  apnsJwtExpiry = now + 3600; // valid for 1 hour
  return apnsJwt;
}

async function sendApnsPush(tokens, notification) {
  if (!APNS_KEY_ID || !APNS_TEAM_ID || !APNS_KEY || !APNS_BUNDLE_ID) {
    console.warn('APNs not configured, skipping push');
    return { success: 0, failed: tokens.length, deleted: 0 };
  }
  
  const jwt = generateApnsJwt();
  if (!jwt) {
    console.error('Failed to generate APNs JWT');
    return { success: 0, failed: tokens.length, deleted: 0 };
  }
  
  const host = APNS_ENV === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
  const payload = JSON.stringify({
    aps: {
      alert: { title: notification.title, body: notification.body },
      sound: 'default',
      badge: 1,
      'mutable-content': 1,
    },
    url: notification.url || '',
    type: notification.type || 'notification',
  });
  
  let success = 0, failed = 0, deleted = 0;
  const deleteTokens = [];
  
  for (const token of tokens) {
    const result = await sendSingleApns(host, token, jwt, payload);
    if (result.success) success++;
    else if (result.invalidToken) { deleted++; deleteTokens.push(token); }
    else failed++;
  }
  
  // Remove invalid tokens from database
  if (db && deleteTokens.length > 0) {
    try {
      await db.query('DELETE FROM devices WHERE token = ANY($1)', [deleteTokens]);
      console.log(`Deleted ${deleteTokens.length} invalid device tokens`);
    } catch (err) {
      console.error('Failed to delete invalid tokens:', err);
    }
  }
  
  return { success, failed, deleted };
}

function sendSingleApns(host, token, jwt, payload) {
  return new Promise((resolve) => {
    const client = http2.connect(`https://${host}`);
    
    const req = client.request({
      ':method': 'POST',
      ':scheme': 'https',
      ':path': `/3/device/${token}`,
      'authorization': `bearer ${jwt}`,
      'apns-topic': APNS_BUNDLE_ID,
      'apns-priority': '10',
      'apns-push-type': 'alert',
    });
    
    let responseData = '';
    req.on('response', (headers) => {
      const status = headers[':status'];
      if (status === 200) {
        client.close();
        resolve({ success: true });
      } else if (status === 410 || (status === 400 && responseData.includes('BadDeviceToken'))) {
        client.close();
        resolve({ success: false, invalidToken: true });
      } else {
        client.close();
        resolve({ success: false });
      }
    });
    
    req.on('data', (chunk) => { responseData += chunk; });
    req.on('error', () => { client.close(); resolve({ success: false }); });
    
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
// tail -> { activeUntil, track: [[t, lat, lon, alt, gs, trk]], ac, lastPoll, feedOk, backoffUntil }
const tails = new Map();
// Cache feed results to avoid hammering APIs
const feedCache = new Map(); // tail -> { data, fetchedAt }
// Cache traffic results
const trafficCache = new Map(); // tail -> { data, fetchedAt }

function entry(tail) {
  let e = tails.get(tail);
  if (!e) {
    if (tails.size >= MAX_TAILS) {
      const oldest = [...tails].sort((a, b) => a[1].activeUntil - b[1].activeUntil)[0];
      tails.delete(oldest[0]);
    }
    e = { activeUntil: 0, track: [], ac: null, lastPoll: 0, feedOk: null, backoffUntil: 0 };
    tails.set(tail, e);
  }
  return e;
}

async function fetchFeed(tail) {
  // Check cache first (2s TTL)
  const cached = feedCache.get(tail);
  if (cached && Date.now() - cached.fetchedAt < CACHE_MS) {
    return cached.data;
  }

  for (const url of FEEDS) {
    try {
      const res = await fetch(url(tail), { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
      if (res.status === 429) {
        // Rate limited - back off for 10 seconds
        const e = entry(tail);
        e.backoffUntil = Date.now() + 10000;
        return null;
      }
      if (!res.ok) continue;
      const data = await res.json();
      // Cache successful result
      feedCache.set(tail, { data, fetchedAt: Date.now() });
      return data;
    } catch {}
  }
  return null;
}

async function poll(tail) {
  const e = entry(tail);
  // Respect backoff period
  if (e.backoffUntil && Date.now() < e.backoffUntil) return;
  
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
  // Only store point if position actually changed (dedupe identical feed samples)
  const last = e.track[e.track.length - 1];
  const lat = +ac.lat.toFixed(5), lon = +ac.lon.toFixed(5);
  if (!last || last[1] !== lat || last[2] !== lon) {
    e.track.push([t, lat, lon, alt == null ? null : Math.round(alt), gs == null ? null : Math.round(gs), trk == null ? null : Math.round(trk)]);
  }
  const cutoff = now() - KEEP_SEC;
  while (e.track.length && e.track[0][0] < cutoff) e.track.shift();
}

/* ---------- Nearby traffic ---------- */
async function fetchTraffic(tail, lat, lon) {
  // Check cache first (3s TTL for traffic)
  const cacheKey = `${tail}:${lat.toFixed(3)}:${lon.toFixed(3)}`;
  const cached = trafficCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < 3000) {
    return cached.data;
  }

  const radius = 10; // nm
  const urls = [
    `https://api.adsb.lol/v2/point/${lat}/${lon}/${radius}`,
    `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${radius}`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
      if (res.status === 429) continue; // Rate limited, try next
      if (!res.ok) continue;
      const data = await res.json();
      
      // Process aircraft list
      const list = Array.isArray(data.ac) ? data.ac : [];
      const aircraft = list
        .filter((a) => {
          const reg = (a.r || '').toUpperCase();
          return reg && reg !== tail && num(a.lat) != null && num(a.lon) != null;
        })
        .map((a) => ({
          tail: a.r?.toUpperCase() || null,
          callsign: a.flight?.trim() || null,
          lat: a.lat,
          lon: a.lon,
          alt: num(a.alt_baro) ?? num(a.alt_geom) ?? 0,
          gs: num(a.gs) ?? 0,
          trk: num(a.track) ?? num(a.true_heading) ?? 0,
          vs: num(a.baro_rate) ?? 0,
        }));
      
      // Cache successful result
      trafficCache.set(cacheKey, { data: aircraft, fetchedAt: Date.now() });
      return aircraft;
    } catch {}
  }
  
  return [];
}

function bearingTo(lat1, lon1, lat2, lon2) {
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
  const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
            Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function distanceNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065; // Earth radius in nautical miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function clockPosition(bearing, ownTrack) {
  const relative = (bearing - ownTrack + 360) % 360;
  const hour = Math.round(relative / 30);
  return hour === 0 ? 12 : hour;
}

function cardinalDir(bearing) {
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return dirs[Math.round(bearing / 22.5) % 16];
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

  // GET /api/traffic/:tail -> nearby traffic for this aircraft
  if (req.method === 'GET' && parts[1] === 'traffic' && parts[2]) {
    const tail = decodeURIComponent(parts[2]).toUpperCase();
    if (!TAIL_RE.test(tail)) return json(res, 400, { error: 'bad tail' });
    const e = entry(tail);
    if (!e.ac || !e.ac.visible || num(e.ac.lat) == null || num(e.ac.lon) == null) {
      return json(res, 200, { traffic: [], nearest: null });
    }
    
    const traffic = await fetchTraffic(tail, e.ac.lat, e.ac.lon);
    
    // Calculate distances and bearings
    const enriched = traffic.map((a) => {
      const dist = distanceNm(e.ac.lat, e.ac.lon, a.lat, a.lon);
      const bearing = bearingTo(e.ac.lat, e.ac.lon, a.lat, a.lon);
      const relAlt = a.alt - (e.ac.alt || 0);
      const clock = e.ac.trk != null ? clockPosition(bearing, e.ac.trk) : null;
      const cardinal = cardinalDir(bearing);
      return { ...a, dist, bearing, relAlt, clock, cardinal };
    });
    
    // Sort by distance
    enriched.sort((a, b) => a.dist - b.dist);
    
    const nearest = enriched[0] || null;
    return json(res, 200, { traffic: enriched.slice(0, 10), nearest });
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
    if (platform !== 'ios') return json(res, 400, { error: 'only iOS supported' });
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
      const pushResult = await sendApnsPush(tokens, {
        title: 'Contrail Test',
        body: 'Push notifications are working!',
        type: 'test',
      });
      return json(res, 200, { 
        sent: pushResult.success, 
        failed: pushResult.failed, 
        deleted: pushResult.deleted,
        devices: tokens.length 
      });
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
        await sendApnsPush(tokens, {
          title: `${pilotName || 'A pilot'} started a flight`,
          body: `${tail}${type ? ' · ' + type : ''} — tap to follow along live.`,
          type: 'flight_start',
          url: trackUrl,
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
        await sendApnsPush(tokens, {
          title: `${pilotName || 'Pilot'} has landed`,
          body: `${tail}${durationStr ? ' · ' + durationStr + ' flight' + distanceStr : ''}.`,
          type: 'flight_end',
          url: trackUrl,
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

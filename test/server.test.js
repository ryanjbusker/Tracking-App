const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const BASE_URL = process.env.TEST_SERVER || 'http://localhost:3000';

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json' },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : null;
          resolve({ status: res.statusCode, body: json });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('ADS-B API', () => {
  test('GET /api/ac/:tail returns aircraft data', async () => {
    const res = await request('GET', '/api/ac/N12345');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body);
    assert.ok(res.body.tail);
    assert.strictEqual(res.body.tail, 'N12345');
  });

  test('GET /api/ac/:tail rejects invalid tail', async () => {
    const res = await request('GET', '/api/ac/invalid@tail');
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error);
  });
});

describe('Track API', () => {
  test('POST /api/track starts tracking', async () => {
    const res = await request('POST', '/api/track', { tail: 'N12345' });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.ok);
  });

  test('POST /api/track/end stops tracking', async () => {
    const res = await request('POST', '/api/track/end', { tail: 'N12345' });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.ok);
  });

  test('POST /api/track rejects invalid tail', async () => {
    const res = await request('POST', '/api/track', { tail: 'bad!' });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error);
  });
});

describe('Device Registration API', () => {
  test('POST /api/device/register requires DATABASE_URL', async () => {
    if (!process.env.DATABASE_URL) {
      const res = await request('POST', '/api/device/register', {
        channel: 'testchannel123',
        token: 'test-apns-token-456',
        platform: 'ios',
      });
      assert.strictEqual(res.status, 503);
      return;
    }
    
    const res = await request('POST', '/api/device/register', {
      channel: 'testchannel123',
      token: 'test-apns-token-456',
      platform: 'ios',
    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.ok);
  });

  test('POST /api/device/register validates input', async () => {
    const res = await request('POST', '/api/device/register', {
      channel: 'invalid-channel!',
      token: 'test-token',
      platform: 'ios',
    });
    assert.ok(res.status === 400 || res.status === 503);
  });

  test('POST /api/device/register rejects non-iOS platforms', async () => {
    const res = await request('POST', '/api/device/register', {
      channel: 'testchannel123',
      token: 'test-token',
      platform: 'android',
    });
    assert.ok(res.status === 400 || res.status === 503);
    if (res.status === 400) {
      assert.ok(res.body.error.includes('iOS'));
    }
  });
});

describe('Follow API', () => {
  test('POST /api/follow creates follower relationship', async () => {
    if (!process.env.DATABASE_URL) {
      const res = await request('POST', '/api/follow', {
        pilotChannel: 'pilot123',
        followerChannel: 'follower456',
      });
      assert.strictEqual(res.status, 503);
      return;
    }

    const res = await request('POST', '/api/follow', {
      pilotChannel: 'pilot123',
      followerChannel: 'follower456',
    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.ok);
  });

  test('POST /api/follow validates channel format', async () => {
    const res = await request('POST', '/api/follow', {
      pilotChannel: 'bad!',
      followerChannel: 'follower456',
    });
    assert.ok(res.status === 400 || res.status === 503);
  });

  test('GET /api/following/:channel returns followed pilots', async () => {
    if (!process.env.DATABASE_URL) {
      const res = await request('GET', '/api/following/follower456');
      assert.strictEqual(res.status, 503);
      return;
    }

    const res = await request('GET', '/api/following/follower456');
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.following));
  });
});

describe('Health Check', () => {
  test('GET /healthz returns ok', async () => {
    const res = await request('GET', '/healthz');
    assert.strictEqual(res.status, 200);
  });
});

describe('Static Files', () => {
  test('GET / returns index.html', async () => {
    const res = await request('GET', '/');
    assert.strictEqual(res.status, 200);
  });

  test('GET /index.html returns HTML', async () => {
    const res = await request('GET', '/index.html');
    assert.strictEqual(res.status, 200);
  });

  test('GET /app.js returns JavaScript', async () => {
    const res = await request('GET', '/app.js');
    assert.strictEqual(res.status, 200);
  });

  test('GET /nonexistent returns 404', async () => {
    const res = await request('GET', '/nonexistent.html');
    assert.strictEqual(res.status, 404);
  });
});

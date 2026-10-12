'use strict';

// Integration: real server.js in-process (hosted mode). A logged-in customer
// can open the dashboard's Companion window and make a new key; the old key
// stops working and the new one drives Companion. A Companion connection
// (Bearer key) cannot replace its own key, and nobody logged out gets in.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');

const PORT = 3967;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const scratchDbPath = path.join(os.tmpdir(), `pt-online-companion-test-${Date.now()}-${process.pid}.sqlite`);
process.env.DATABASE_PATH = scratchDbPath;
process.env.PORT = String(PORT);
process.env.LEGACY_ROOMS_JSON_PATH = path.join(os.tmpdir(), `pt-online-companion-test-no-such-file-${Date.now()}.json`);

const realConsoleLog = console.log;
console.log = () => {};

const db = require('../db');

let capturedServer = null;
const originalCreateServer = http.createServer.bind(http);
http.createServer = (...args) => { capturedServer = originalCreateServer(...args); return capturedServer; };
require('../server');
http.createServer = originalCreateServer;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(method, pathname, { cookie, key, body } = {}) {
  return fetch(`${BASE_URL}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(key ? { Authorization: `Bearer ${key}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

let cookie; let firstKey;

test.before(async () => {
  for (let i = 0; i < 50 && !(capturedServer && capturedServer.listening); i++) await sleep(50);
  const client = db.createClient('Companion Online Co');
  firstKey = client.apiKey;
  db.createUser('crew@online.test', 'crew-pass-123', client.id);
  const res = await request('POST', '/api/auth/login', { body: { email: 'crew@online.test', password: 'crew-pass-123' } });
  assert.equal(res.status, 200);
  cookie = res.headers.get('set-cookie').split(';')[0];
  for (const slug of ['main-stage', 'breakout-1']) {
    assert.equal((await request('POST', '/api/rooms', { cookie, body: { slug } })).status, 200);
  }
});

test.after(() => {
  console.log = realConsoleLog;
  capturedServer.close();
  setTimeout(() => process.exit(0), 100).unref();
  try { fs.unlinkSync(scratchDbPath); } catch { /* ignore */ }
});

test('online Companion window: details, new key, old key revoked', async () => {
  // The window's details: server address, rooms, when the key was made - never the key itself
  let res = await request('GET', '/api/companion', { cookie });
  assert.equal(res.status, 200);
  let data = await res.json();
  assert.equal(data.serverUrl, BASE_URL);
  assert.deepEqual([...data.rooms].sort(), ['breakout-1', 'main-stage']);
  assert.equal(data.apiKey, null);
  assert.ok(data.keyMadeAt > 0);

  // The client's original key works for Companion
  assert.equal((await request('GET', '/api/rooms/main-stage/companion', { key: firstKey })).status, 200);

  // Make a new key: shown once, and it works
  res = await request('POST', '/api/companion/new-key', { cookie });
  assert.equal(res.status, 200);
  data = await res.json();
  assert.ok(data.apiKey && data.apiKey !== firstKey);
  assert.equal((await request('GET', '/api/rooms/main-stage/companion', { key: data.apiKey })).status, 200);

  // The old key stops working straight away
  assert.equal((await request('GET', '/api/rooms/main-stage/companion', { key: firstKey })).status, 401);

  // A reopened window doesn't show the key again
  assert.equal((await (await request('GET', '/api/companion', { cookie })).json()).apiKey, null);

  // A Companion connection can't open the window or replace its own key
  assert.equal((await request('GET', '/api/companion', { key: data.apiKey })).status, 403);
  assert.equal((await request('POST', '/api/companion/new-key', { key: data.apiKey })).status, 403);
  assert.equal((await request('GET', '/api/rooms/main-stage/companion', { key: data.apiKey })).status, 200);

  // Logged out: refused
  assert.equal((await request('GET', '/api/companion')).status, 401);
  assert.equal((await request('POST', '/api/companion/new-key')).status, 401);
});

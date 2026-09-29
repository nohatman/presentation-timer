'use strict';

// Integration: real server.js in-process in Local Show Server mode
// (FOXY_MODE=local). First run creates a starter room; the operator at the
// laptop itself (loopback + loopback Host + same-origin) gets the dashboard API
// without logging in; links point at the LAN address; nothing else gets in.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');

const PORT = 3965;

const scratchDbPath = path.join(os.tmpdir(), `pt-localmode-test-${Date.now()}-${process.pid}.sqlite`);
process.env.DATABASE_PATH = scratchDbPath;
process.env.PORT = String(PORT);
process.env.LEGACY_ROOMS_JSON_PATH = path.join(os.tmpdir(), `pt-localmode-test-no-such-file-${Date.now()}.json`);
process.env.FOXY_MODE = 'local';
delete process.env.FOXY_SHUTDOWN_TOKEN;

const realConsoleLog = console.log;
console.log = () => {};

const { selectLanAddresses } = require('../tools/local-server/lib/lan');

let capturedServer = null;
const originalCreateServer = http.createServer.bind(http);
http.createServer = (...args) => { capturedServer = originalCreateServer(...args); return capturedServer; };
require('../server');
http.createServer = originalCreateServer;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Raw request so the Host header can be set (fetch forbids it).
function request(method, pathname, { headers = {}, body, host = `localhost:${PORT}`, via } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: via || '127.0.0.1', port: PORT, method, path: pathname, ...(via ? { localAddress: via } : {}),
      headers: { Host: host, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers }
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test.before(async () => {
  for (let i = 0; i < 50 && !(capturedServer && capturedServer.listening); i++) await sleep(50);
});

test.after(() => {
  console.log = realConsoleLog;
  delete process.env.FOXY_MODE;
  capturedServer.close();
  setTimeout(() => process.exit(0), 100).unref();
  try { fs.unlinkSync(scratchDbPath); } catch { /* ignore */ }
});

test('first run: starter room, no-login dashboard on the laptop, LAN links', async () => {
  const who = await request('GET', '/api/whoami');
  assert.equal(who.status, 200);
  assert.equal(who.json.localOperator, true);
  assert.equal(who.json.name, 'Local show');

  const rooms = await request('GET', '/api/rooms');
  assert.equal(rooms.status, 200);
  assert.equal(rooms.json.length, 1);
  assert.equal(rooms.json[0].slug, 'Main stage');

  const lan = selectLanAddresses().primary;
  const linkHost = new URL(rooms.json[0].controlUrl).host;
  assert.equal(linkHost, lan ? `${lan.address}:${PORT}` : `localhost:${PORT}`);

  // The laptop reaching itself on its own LAN address counts too (e.g. the
  // Dashboard link on a Control page opened from a LAN link)
  if (lan) assert.equal((await request('GET', '/api/rooms', { host: `${lan.address}:${PORT}` })).status, 200, 'own LAN address as Host');
  if (lan) assert.equal((await request('GET', '/api/rooms', { host: `${lan.address}:${PORT}`, via: lan.address })).status, 200, 'connecting from the laptop own LAN address');

  // 127.0.0.1 counts as the laptop too
  assert.equal((await request('GET', '/api/rooms', { host: `127.0.0.1:${PORT}` })).status, 200);

  // Same-origin create and QR work
  const created = await request('POST', '/api/rooms', { body: { slug: 'Breakout 1' }, headers: { Origin: `http://localhost:${PORT}` } });
  assert.equal(created.status, 200);
  const qr = await request('POST', '/api/qr', { body: { text: created.json.controlUrl }, headers: { 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(qr.status, 200);
  assert.match(qr.json.svg, /^<svg/);

  // '/' goes to the dashboard on a show laptop
  const home = await request('GET', '/');
  assert.equal(home.status, 302);
  assert.equal(home.headers.location, '/dashboard');
});

test('Companion on a show laptop: details on the dashboard, and the key drives the REST API', async () => {
  const details = await request('GET', '/api/local/companion');
  assert.equal(details.status, 200);
  const { serverUrl, apiKey, rooms } = details.json;
  assert.match(apiKey, /^key_/);
  assert.ok(rooms.includes('Main stage'));
  const lan = selectLanAddresses().primary;
  assert.equal(serverUrl, lan ? `http://${lan.address}:${PORT}` : `http://localhost:${PORT}`);

  // Same key on every visit
  assert.equal((await request('GET', '/api/local/companion')).json.apiKey, apiKey);

  // What Companion does from the Stream Deck PC: Bearer key + room name (with
  // its space) in the URL, arriving over the LAN - a non-loopback Host, so the
  // laptop's own no-login access doesn't apply and the key has to do the work.
  const auth = { Authorization: `Bearer ${apiKey}` };
  const viaLan = (method, path, headers) => request(method, path, { headers, host: `192.168.1.50:${PORT}` });
  const poll = await viaLan('GET', `/api/rooms/${encodeURIComponent('Main stage')}/companion`, auth);
  assert.equal(poll.status, 200);
  assert.equal(poll.json.mode, 'stopped');
  assert.equal((await viaLan('POST', `/api/rooms/${encodeURIComponent('Main stage')}/start`, auth)).status, 200);
  assert.equal((await viaLan('GET', `/api/rooms/${encodeURIComponent('Main stage')}/companion`, auth)).json.mode, 'running');
  await viaLan('POST', `/api/rooms/${encodeURIComponent('Main stage')}/reset`, auth);

  // A new key replaces the old one
  const renewed = await request('POST', '/api/local/companion/new-key', { headers: { Origin: `http://localhost:${PORT}` } });
  assert.notEqual(renewed.json.apiKey, apiKey);
  assert.equal((await viaLan('GET', `/api/rooms/${encodeURIComponent('Main stage')}/companion`, auth)).status, 401, 'old key stops working');
  assert.equal((await viaLan('GET', `/api/rooms/${encodeURIComponent('Main stage')}/companion`, { Authorization: `Bearer ${renewed.json.apiKey}` })).status, 200);

  // Not from another device, nor from another site in the laptop's browser
  assert.equal((await request('GET', '/api/local/companion', { host: `192.168.1.50:${PORT}` })).status, 401);
  assert.equal((await request('GET', '/api/local/companion', { headers: { Origin: 'http://evil.example' } })).status, 401);
});

test('This laptop panel: status with addresses and a firewall reading; laptop-only', async () => {
  const st = await request('GET', '/api/local/status');
  assert.equal(st.status, 200);
  assert.equal(st.json.ok, true);
  assert.equal(st.json.port, PORT);
  assert.ok(Array.isArray(st.json.addresses));
  assert.ok(['ok', 'blocked', 'unknown'].includes(st.json.firewall.state));
  // Stop / restart / firewall change / status: never from another device or another site
  for (const [method, route] of [['GET', '/api/local/status'], ['POST', '/api/local/stop'], ['POST', '/api/local/restart'], ['POST', '/api/local/firewall/allow']]) {
    assert.equal((await request(method, route, { host: `192.168.1.50:${PORT}` })).status, 401, `${route} from the LAN`);
    assert.equal((await request(method, route, { headers: { Origin: 'http://evil.example' } })).status, 401, `${route} cross-site`);
  }
});

test('nobody else gets the no-login dashboard', async () => {
  const cases = [
    ['a non-loopback Host (DNS rebinding)', { host: `evil.example:${PORT}` }],
    ['a LAN-address Host', { host: `192.168.1.50:${PORT}` }],
    ['another site\'s Origin', { headers: { Origin: 'http://evil.example' } }],
    ['another site\'s Referer', { headers: { Referer: 'http://evil.example/page' } }],
    ['Sec-Fetch-Site: cross-site', { headers: { 'Sec-Fetch-Site': 'cross-site' } }],
  ];
  for (const [label, opts] of cases) {
    assert.equal((await request('GET', '/api/rooms', opts)).status, 401, label);
  }
  assert.equal((await request('POST', '/api/rooms', { body: { slug: 'x' }, headers: { Origin: 'http://evil.example' } })).status, 401);
});

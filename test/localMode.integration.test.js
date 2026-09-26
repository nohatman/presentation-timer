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
function request(method, pathname, { headers = {}, body, host = `localhost:${PORT}` } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: PORT, method, path: pathname,
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

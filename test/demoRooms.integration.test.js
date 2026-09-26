'use strict';

// Integration: real server.js in-process with real socket.io-client
// connections. "Try it now" creates a seeded demo room with working links and
// QR codes, is rate-limited per IP, and the room is deleted when it expires -
// connected panels are told the demo ended, and the links stop working.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const { io: ioClient } = require('socket.io-client');

const PORT = 3964;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const scratchDbPath = path.join(os.tmpdir(), `pt-demo-test-${Date.now()}-${process.pid}.sqlite`);
process.env.DATABASE_PATH = scratchDbPath;
process.env.PORT = String(PORT);
process.env.LEGACY_ROOMS_JSON_PATH = path.join(os.tmpdir(), `pt-demo-test-no-such-file-${Date.now()}.json`);
process.env.DEMO_TTL_MIN = '0.04'; // 2.4 s
process.env.DEMO_SWEEP_MS = '200';
process.env.DEMO_PER_IP_PER_HOUR = '3';

const realConsoleLog = console.log;
console.log = () => {};

const db = require('../db');
const { DEMO_CLIENT_NAME } = require('../demoRooms');

let capturedServer = null;
const originalCreateServer = http.createServer.bind(http);
http.createServer = (...args) => { capturedServer = originalCreateServer(...args); return capturedServer; };
require('../server');
http.createServer = originalCreateServer;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tokenOf = (url) => new URL(url).searchParams.get('token');

function connect(token) {
  const socket = ioClient(BASE_URL, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
  const panel = { socket, state: null, demoInfo: null, authError: null };
  socket.on('timerState', (s) => { panel.state = s; });
  socket.on('demoInfo', (d) => { panel.demoInfo = d; });
  socket.on('authError', (e) => { panel.authError = e; });
  return panel;
}

async function waitFor(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(25); }
  throw new Error('timed out waiting');
}

test.before(async () => {
  for (let i = 0; i < 50 && !(capturedServer && capturedServer.listening); i++) await sleep(50);
});

test.after(() => {
  console.log = realConsoleLog;
  capturedServer.close();
  setTimeout(() => process.exit(0), 100).unref();
  try { fs.unlinkSync(scratchDbPath); } catch { /* ignore */ }
});

test('demo room: create, seeded, demoInfo, expiry, rate limit', async () => {
  const res = await fetch(`${BASE_URL}/api/demo`, { method: 'POST' });
  assert.equal(res.status, 200);
  const demo = await res.json();
  assert.equal(demo.ok, true);
  assert.match(demo.controlUrl, /\/control\?token=/);
  assert.match(demo.displayUrl, /\/display\?token=/);
  assert.match(demo.controlQr, /^<svg/);
  assert.match(demo.displayQr, /^<svg/);
  assert.ok(demo.expiresAt > Date.now());

  // Owned by the demo client, which has no users (nobody can log in to it)
  const demoClient = db.getClientByName(DEMO_CLIENT_NAME);
  assert.ok(demoClient);
  assert.equal(db.listUsers().filter((u) => u.client_id === demoClient.id).length, 0);

  // Control gets seeded state and demoInfo; display gets state but it's the same room
  const control = connect(tokenOf(demo.controlUrl));
  const display = connect(tokenOf(demo.displayUrl));
  await waitFor(() => control.state && control.demoInfo && display.state);
  assert.equal(control.demoInfo.expiresAt, demo.expiresAt);
  assert.equal(control.state.rundown.length, 4);
  assert.equal(control.state.rundownIndex, 0);
  assert.equal(control.state.mode, 'stopped');

  // Expiry: both are told the demo ended, and the links stop working
  await waitFor(() => control.authError && display.authError, 5000);
  assert.equal(control.authError.reason, 'demo_ended');
  assert.equal(display.authError.reason, 'demo_ended');
  assert.equal(db.getRoomByToken(tokenOf(demo.controlUrl)), null);

  const late = connect(tokenOf(demo.controlUrl));
  await waitFor(() => late.authError);
  assert.notEqual(late.authError.reason, 'demo_ended');
  late.socket.close(); control.socket.close(); display.socket.close();

  // Per-IP limit: 3 an hour (one used above)
  assert.equal((await fetch(`${BASE_URL}/api/demo`, { method: 'POST' })).status, 200);
  assert.equal((await fetch(`${BASE_URL}/api/demo`, { method: 'POST' })).status, 200);
  const limited = await fetch(`${BASE_URL}/api/demo`, { method: 'POST' });
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).ok, false);

  // /try page is served
  assert.equal((await fetch(`${BASE_URL}/try`)).status, 200);
});

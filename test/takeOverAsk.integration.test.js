'use strict';

// Integration: "Ask before handing over" (the room's takeOverAsk setting).
// Take over asks the panel in control; Allow / Refuse / no answer / the panel
// in control leaving / the asker cancelling. Same in-process server + real
// socket.io harness as the other integration tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { io: ioClient } = require('socket.io-client');

const PORT = 3952;
const BASE_URL = `http://127.0.0.1:${PORT}`;

process.env.DATABASE_PATH = path.join(os.tmpdir(), `pt-ask-test-${Date.now()}-${process.pid}.sqlite`);
process.env.PORT = String(PORT);
process.env.LEGACY_ROOMS_JSON_PATH = path.join(os.tmpdir(), `pt-ask-test-no-such-file-${Date.now()}.json`);
process.env.TAKE_OVER_ASK_MS = '600'; // "no answer" comes quickly in tests

const realConsoleLog = console.log;
console.log = () => {};

const db = require('../db');

let capturedServer = null;
const originalCreateServer = http.createServer.bind(http);
http.createServer = (...args) => { capturedServer = originalCreateServer(...args); return capturedServer; };
require('../server');
http.createServer = originalCreateServer;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tokenOf = (url) => new URL(url).searchParams.get('token');
const once = (s, ev) => new Promise((resolve) => s.once(ev, resolve));
const sockets = [];
let key;

// A control panel that keeps track of who is in control.
async function panel(token, name) {
  const s = ioClient(BASE_URL, { auth: { token, deviceName: name, panelId: `p-${name}`, deviceId: `d-${name}` }, transports: ['websocket'], reconnection: false, forceNew: true });
  sockets.push(s);
  s.controller = null;
  s.on('controllerStatus', (st) => { s.controller = st.activeControllerSocketId; });
  await once(s, 'timerState');
  await sleep(100);
  return s;
}
const inControl = (s) => s.controller === s.id;

async function roomWithAsk(slug) {
  const res = await fetch(`${BASE_URL}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ slug }) });
  const room = await res.json();
  const token = tokenOf(room.controlUrl);
  const a = await panel(token, 'A');
  assert.ok(inControl(a), 'the first panel is in control');
  a.emit('updateSettings', { takeOverAsk: true });
  await sleep(100);
  const b = await panel(token, 'B');
  assert.ok(!inControl(b));
  return { a, b };
}

test.before(async () => {
  for (let i = 0; i < 20; i++) { try { await fetch(`${BASE_URL}/`); break; } catch { await sleep(100); } }
  key = db.createClient('Ask Client').apiKey;
});

test.after(async () => {
  sockets.forEach((s) => s.close());
  await new Promise((resolve) => {
    if (!capturedServer) return resolve();
    if (typeof capturedServer.closeAllConnections === 'function') capturedServer.closeAllConnections();
    capturedServer.close(() => resolve());
  });
  console.log = realConsoleLog;
  setTimeout(() => process.exit(0), 300); // server.js's 1 s timer tick keeps the process alive
});

test('Allow hands control over; Refuse keeps it', async () => {
  const { a, b } = await roomWithAsk('Allow room');
  let asked = once(a, 'takeOverRequest');
  const asking = once(b, 'takeOverAsking');
  b.emit('requestControl');
  const req = await asked;
  assert.equal(req.requesterName, 'B');
  assert.equal((await asking).holderName, 'A');
  assert.ok(inControl(a), 'nothing changes while asking');

  let result = once(b, 'takeOverResult');
  a.emit('takeOverAnswer', { id: req.id, allow: false });
  assert.equal((await result).result, 'refused');
  await sleep(100);
  assert.ok(inControl(a));

  asked = once(a, 'takeOverRequest');
  b.emit('requestControl');
  const req2 = await asked;
  result = once(b, 'takeOverResult');
  a.emit('takeOverAnswer', { id: req2.id, allow: true });
  assert.equal((await result).result, 'allowed');
  await sleep(100);
  assert.ok(inControl(b));
});

test('no answer hands over; so does the panel in control leaving', async () => {
  const { a, b } = await roomWithAsk('Timeout room');
  const ended = once(a, 'takeOverRequestEnded');
  b.emit('requestControl');
  assert.equal((await ended).result, 'timeout');
  await sleep(100);
  assert.ok(inControl(b), 'no answer: control passes');

  // now B is in control (the setting is still on); A asks, then B disappears
  const asked = once(b, 'takeOverRequest');
  a.emit('requestControl');
  await asked;
  const result = once(a, 'takeOverResult');
  b.close();
  assert.equal((await result).result, 'holderLeft');
  await sleep(100);
  assert.ok(inControl(a));
});

test('the asker can cancel, and without the setting Take over is instant', async () => {
  const { a, b } = await roomWithAsk('Cancel room');
  const asked = once(a, 'takeOverRequest');
  b.emit('requestControl');
  await asked;
  const ended = once(a, 'takeOverRequestEnded');
  b.emit('takeOverCancel');
  assert.equal((await ended).result, 'cancelled');
  assert.ok(inControl(a));

  a.emit('updateSettings', { takeOverAsk: false });
  await sleep(100);
  b.emit('requestControl');
  await sleep(150);
  assert.ok(inControl(b), 'instant when the setting is off');
});

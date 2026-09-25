'use strict';

// Integration: real server.js in-process (same harness as timerModes.integration)
// with real socket.io-client connections. Device names are a label carried on
// the existing controllerStatus / controllerCount events - additive fields only.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const { io: ioClient } = require('socket.io-client');

const PORT = 3961;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const scratchDbPath = path.join(os.tmpdir(), `pt-devicenames-test-${Date.now()}-${process.pid}.sqlite`);
process.env.DATABASE_PATH = scratchDbPath;
process.env.PORT = String(PORT);
process.env.LEGACY_ROOMS_JSON_PATH = path.join(os.tmpdir(), `pt-devicenames-test-no-such-file-${Date.now()}.json`);

const realConsoleLog = console.log;
console.log = () => {};

const db = require('../db');

let capturedServer = null;
const originalCreateServer = http.createServer.bind(http);
http.createServer = (...args) => { capturedServer = originalCreateServer(...args); return capturedServer; };
require('../server');
http.createServer = originalCreateServer;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A panel records the latest controllerStatus / controllerCount it received.
function connect(token, deviceName) {
  const auth = deviceName === undefined ? { token } : { token, deviceName };
  const socket = ioClient(BASE_URL, { auth, transports: ['websocket'], reconnection: false, forceNew: true });
  const panel = { socket, status: null, count: null };
  socket.on('controllerStatus', (s) => { panel.status = s; });
  socket.on('controllerCount', (c) => { panel.count = c; });
  panel.ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no initial timerState')), 3000);
    socket.once('timerState', () => { clearTimeout(t); resolve(); });
    socket.once('connect_error', reject);
  });
  return panel;
}

let apiKey; let roomCounter = 0;
async function createRoom() {
  roomCounter += 1;
  const slug = `dn-room-${Date.now()}-${roomCounter}`;
  const res = await fetch(`${BASE_URL}/api/rooms`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ slug }),
  });
  const body = await res.json();
  assert.ok(body.ok, JSON.stringify(body));
  return { controlToken: new URL(body.controlUrl).searchParams.get('token'), displayToken: new URL(body.displayUrl).searchParams.get('token') };
}

test.before(async () => {
  for (let i = 0; i < 20; i++) { try { await fetch(`${BASE_URL}/`); break; } catch { await sleep(100); } }
  apiKey = db.createClient('Device Names Test Client').apiKey;
});

test.after(async () => {
  await new Promise((resolve) => {
    if (!capturedServer) return resolve();
    if (typeof capturedServer.closeAllConnections === 'function') capturedServer.closeAllConnections();
    capturedServer.close(() => resolve());
  });
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(scratchDbPath + suffix); } catch { /* ignore */ } }
  console.log = realConsoleLog;
  setTimeout(() => process.exit(0), 300);
});

test('controller name travels with controllerStatus; every panel is listed in controllerCount', async () => {
  const room = await createRoom();
  const a = connect(room.controlToken, "Peter's iPad"); await a.ready; await sleep(150);
  const b = connect(room.controlToken, 'Amber Otter'); await b.ready; await sleep(250);
  try {
    assert.equal(a.status.activeControllerSocketId, a.socket.id, 'first panel is the controller');
    assert.equal(a.status.activeControllerName, "Peter's iPad");
    assert.equal(b.status.activeControllerName, "Peter's iPad", 'a joining observer is told who is in control');
    assert.equal(b.count.count, 2);
    assert.deepEqual(b.count.panels.map(p => p.name).sort(), ['Amber Otter', "Peter's iPad"]);
    assert.deepEqual(b.count.panels.flatMap(p => p.ids).sort(), [a.socket.id, b.socket.id].sort());
  } finally { a.socket.close(); b.socket.close(); }
});

test('Take Over: everyone learns the NEW controller\'s name', async () => {
  const room = await createRoom();
  const a = connect(room.controlToken, "Peter's iPad"); await a.ready; await sleep(150);
  const b = connect(room.controlToken, 'Amber Otter'); await b.ready; await sleep(200);
  try {
    b.socket.emit('requestControl'); await sleep(250);
    assert.equal(a.status.activeControllerSocketId, b.socket.id);
    assert.equal(a.status.activeControllerName, 'Amber Otter', 'the panel that lost control can say who took it');
  } finally { a.socket.close(); b.socket.close(); }
});

test('rename: sanitised, re-broadcast to the room, allowed for an observer, blank ignored', async () => {
  const room = await createRoom();
  const a = connect(room.controlToken, 'Swift Heron'); await a.ready; await sleep(150);
  const b = connect(room.controlToken, 'Calm Seal'); await b.ready; await sleep(200);
  try {
    a.socket.emit('setDeviceName', '  FOH   Desk ' + String.fromCodePoint(0x202e)); await sleep(250);
    assert.equal(b.status.activeControllerName, 'FOH Desk', 'controller rename reaches the observer, cleaned up');
    b.socket.emit('setDeviceName', 'Backstage'); await sleep(250); // b is an observer
    assert.ok(a.count.panels.some(p => p.ids.includes(b.socket.id) && p.name === 'Backstage'), 'observer rename is listed');
    b.socket.emit('setDeviceName', '   '); await sleep(200);
    b.socket.emit('setDeviceName', { not: 'a string' }); await sleep(200);
    assert.ok(a.count.panels.some(p => p.ids.includes(b.socket.id) && p.name === 'Backstage'), 'blank/invalid names are ignored');
  } finally { a.socket.close(); b.socket.close(); }
});

test('a panel that sends no name is null (the page shows "another panel"); a display socket cannot rename', async () => {
  const room = await createRoom();
  const a = connect(room.controlToken); await a.ready; await sleep(150);
  const d = connect(room.displayToken, 'Sneaky Display'); await d.ready; await sleep(150);
  try {
    assert.equal(a.status.activeControllerName, null);
    assert.equal(a.count.count, 1, 'display sockets are not control panels');
    d.socket.emit('setDeviceName', 'Sneaky Display'); await sleep(200);
    assert.deepEqual(a.count.panels.map(p => p.name), [null]);
  } finally { a.socket.close(); d.socket.close(); }
});

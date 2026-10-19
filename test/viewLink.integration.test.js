'use strict';

// Integration: View links (a client watches the control page, changes nothing).
// The server must refuse every change from a View link, never make it the
// controller, and never tell it the control link. Same in-process server + real
// socket.io harness as the other integration tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { io: ioClient } = require('socket.io-client');

const PORT = 3953;
const BASE_URL = `http://127.0.0.1:${PORT}`;

process.env.DATABASE_PATH = path.join(os.tmpdir(), `pt-view-test-${Date.now()}-${process.pid}.sqlite`);
process.env.PORT = String(PORT);
process.env.LEGACY_ROOMS_JSON_PATH = path.join(os.tmpdir(), `pt-view-test-no-such-file-${Date.now()}.json`);

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
const sockets = [];
const connect = (auth) => { const s = ioClient(BASE_URL, { auth, transports: ['websocket'], reconnection: false, forceNew: true }); sockets.push(s); return s; };
const api = (key, p, method = 'GET', body) => fetch(`${BASE_URL}${p}`, {
  method,
  headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, ...(await r.json()) }));

let room;

test.before(async () => {
  for (let i = 0; i < 20; i++) { try { await fetch(`${BASE_URL}/`); break; } catch { await sleep(100); } }
  const key = db.createClient('View Client').apiKey;
  room = await api(key, '/api/rooms', 'POST', { slug: 'Main stage' });
  assert.ok(room.ok && room.viewUrl, JSON.stringify(room));
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

test('a View link sees the room and its display link, never the control link, and changes nothing', async () => {
  assert.match(room.viewUrl, /\/control\?token=/);
  const viewer = connect({ token: tokenOf(room.viewUrl), deviceName: 'Client', panelId: 'v1', deviceId: 'dv' });
  const first = await new Promise((resolve) => viewer.once('timerState', resolve));
  assert.deepEqual(Object.keys(first.roomInfo).sort(), ['displayUrl', 'slug', 'viewer']);
  assert.equal(first.roomInfo.displayUrl, room.displayUrl);
  assert.equal(first.mode, 'stopped');

  // Even with nobody else connected, it never becomes the controller...
  const rejected = new Promise((resolve) => viewer.once('controlRejected', resolve));
  viewer.emit('requestControl');
  viewer.emit('startTimer', {});
  viewer.emit('setOutputMode', 'clock');
  viewer.emit('setRundown', [{ name: 'Hacked', durationMs: 60000 }]);
  await sleep(300);
  // ...and nothing it sent changed the room (a requireActiveController check
  // stays silent for non-control roles, so no rejection is needed either way).
  await Promise.race([rejected, sleep(50)]);
  const control = connect({ token: tokenOf(room.controlUrl), deviceName: 'Op', panelId: 'c1', deviceId: 'dc' });
  const statusP = new Promise((resolve) => control.once('controllerStatus', resolve));
  const state = await new Promise((resolve) => control.once('timerState', resolve));
  assert.equal(state.mode, 'stopped');
  assert.equal(state.outputMode, 'timer');
  assert.deepEqual(state.rundown, []);
  assert.ok(state.roomInfo.controlUrl, 'the control link still gets every link');
  assert.equal(state.roomInfo.viewUrl, room.viewUrl);

  // The real operator is the controller straight away: the viewer never held the seat.
  const status = await statusP;
  assert.equal(status.activeControllerSocketId, control.id);

  // A View link can't fetch the share links either.
  assert.equal((await api(null, '/api/room-links', 'POST', { token: tokenOf(room.viewUrl) })).status, 403);
  const share = await api(null, '/api/room-links', 'POST', { token: tokenOf(room.controlUrl) });
  assert.equal(share.viewUrl, room.viewUrl);
  assert.match(share.viewQr, /<svg/);
});

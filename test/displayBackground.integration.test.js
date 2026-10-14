'use strict';

// Integration: the Display background image. The active controller uploads it
// over HTTP (room control token + its socket id); every panel and display hears
// the new version in timerState; either link token can fetch the bytes; observers,
// display links and non-images are refused; Remove clears it. Same in-process
// server + real socket.io harness as the other integration tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const { io: ioClient } = require('socket.io-client');

const PORT = 3966;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const scratchDbPath = path.join(os.tmpdir(), `pt-bg-test-${Date.now()}-${process.pid}.sqlite`);
process.env.DATABASE_PATH = scratchDbPath;
process.env.PORT = String(PORT);
process.env.LEGACY_ROOMS_JSON_PATH = path.join(os.tmpdir(), `pt-bg-test-no-such-file-${Date.now()}.json`);

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

// Smallest valid PNG header + a little payload is enough: the server sniffs the
// signature, it doesn't decode the image.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body')]);

function connect(token) {
  const socket = ioClient(BASE_URL, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
  const panel = { socket, state: null };
  socket.on('timerState', (s) => { panel.state = s; });
  panel.ready = new Promise((resolve, reject) => {
    socket.once('timerState', () => resolve());
    socket.once('connect_error', reject);
  });
  return panel;
}
async function open(token) { const p = connect(token); await p.ready; await sleep(150); return p; }

let apiKey;
async function createRoom() {
  const res = await fetch(`${BASE_URL}/api/rooms`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ slug: `bg-room-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }),
  });
  const body = await res.json();
  assert.ok(body.ok, JSON.stringify(body));
  return { control: tokenOf(body.controlUrl), display: tokenOf(body.displayUrl) };
}

const put = (token, socketId, body) => fetch(`${BASE_URL}/api/display-background`, {
  method: 'PUT', headers: { 'X-Room-Token': token, 'X-Socket-Id': socketId, 'Content-Type': 'image/png' }, body,
});

test.before(async () => {
  for (let i = 0; i < 20; i++) { try { await fetch(`${BASE_URL}/`); break; } catch { await sleep(100); } }
  apiKey = db.createClient('Background Test Client').apiKey;
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

test('controller uploads a PNG: displays get the version, both tokens can fetch it, Remove clears it', async () => {
  const { control, display } = await createRoom();
  const ctl = await open(control);
  const scr = await open(display);
  assert.equal(scr.state.displayBgImage, null);

  const res = await put(control, ctl.socket.id, PNG);
  assert.equal(res.status, 200);
  const { version } = await res.json();
  await sleep(150);
  assert.equal(scr.state.displayBgImage, version);

  for (const token of [display, control]) {
    const img = await fetch(`${BASE_URL}/api/display-background?token=${token}&v=${version}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);
  }

  const del = await fetch(`${BASE_URL}/api/display-background`, {
    method: 'DELETE', headers: { 'X-Room-Token': control, 'X-Socket-Id': ctl.socket.id },
  });
  assert.equal(del.status, 200);
  await sleep(150);
  assert.equal(scr.state.displayBgImage, null);
  assert.equal((await fetch(`${BASE_URL}/api/display-background?token=${display}`)).status, 404);
  ctl.socket.close(); scr.socket.close();
});

test('refused: observer panel, display token, bad token, and a file that is not an image', async () => {
  const { control, display } = await createRoom();
  const ctl = await open(control);
  const observer = await open(control);
  const scr = await open(display);

  assert.equal((await put(control, observer.socket.id, PNG)).status, 409);
  assert.equal((await put(display, scr.socket.id, PNG)).status, 403);
  assert.equal((await put('not-a-token', ctl.socket.id, PNG)).status, 401);
  assert.equal((await put(control, ctl.socket.id, Buffer.from('<svg onload=alert(1)>'))).status, 415);
  await sleep(100);
  assert.equal(scr.state.displayBgImage, null);
  assert.equal((await fetch(`${BASE_URL}/api/display-background?token=nope`)).status, 401);
  ctl.socket.close(); observer.socket.close(); scr.socket.close();
});

test('display toggles and image fit are validated settings', async () => {
  const { control, display } = await createRoom();
  const ctl = await open(control);
  const scr = await open(display);
  assert.equal(scr.state.showStatus, true);
  assert.equal(scr.state.showRoomBadge, true);
  ctl.socket.emit('updateSettings', { showStatus: false, showRoomBadge: false, displayBgFit: 'contain' });
  await sleep(150);
  assert.equal(scr.state.showStatus, false);
  assert.equal(scr.state.showRoomBadge, false);
  assert.equal(scr.state.displayBgFit, 'contain');
  ctl.socket.emit('updateSettings', { displayBgFit: 'url(evil)' });
  await sleep(150);
  assert.equal(scr.state.displayBgFit, 'contain');
  ctl.socket.close(); scr.socket.close();
});

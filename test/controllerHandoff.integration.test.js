'use strict';

// Integration: who holds control must survive the controller's own connection
// dropping and coming back (a page refresh, a phone locking/backgrounding the
// tab, a Wi-Fi/4G hand-over). Real server.js in-process + real socket.io
// clients, same harness as the other integration tests. The grace period is
// shortened via CONTROLLER_GRACE_MS so expiry can be tested quickly.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const { io: ioClient } = require('socket.io-client');

const PORT = 3962;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const GRACE_MS = 700;

const scratchDbPath = path.join(os.tmpdir(), `pt-handoff-test-${Date.now()}-${process.pid}.sqlite`);
process.env.DATABASE_PATH = scratchDbPath;
process.env.PORT = String(PORT);
process.env.CONTROLLER_GRACE_MS = String(GRACE_MS);
process.env.LEGACY_ROOMS_JSON_PATH = path.join(os.tmpdir(), `pt-handoff-test-no-such-file-${Date.now()}.json`);

const realConsoleLog = console.log;
console.log = () => {};

const db = require('../db');

let capturedServer = null;
const originalCreateServer = http.createServer.bind(http);
http.createServer = (...args) => { capturedServer = originalCreateServer(...args); return capturedServer; };
require('../server');
http.createServer = originalCreateServer;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One control-page connection. panelId = the per-tab id the page sends (stable
// across a refresh of that tab); omit it to behave like a page without one.
function connect(token, panelId, deviceName, deviceId) {
  const auth = { token };
  if (panelId) auth.panelId = panelId;
  if (deviceName) auth.deviceName = deviceName;
  if (deviceId) auth.deviceId = deviceId;
  const socket = ioClient(BASE_URL, { auth, transports: ['websocket'], reconnection: false, forceNew: true });
  const panel = { socket, status: null, get isController() { return !!this.status && this.status.activeControllerSocketId === socket.id; } };
  socket.on('controllerStatus', (s) => { panel.status = s; });
  panel.ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no initial timerState')), 3000);
    socket.once('timerState', () => { clearTimeout(t); resolve(); });
    socket.once('connect_error', reject);
  });
  return panel;
}
async function open(token, panelId, name, deviceId) { const p = connect(token, panelId, name, deviceId); await p.ready; await sleep(150); return p; }

let apiKey; let roomCounter = 0;
async function createRoom() {
  roomCounter += 1;
  const res = await fetch(`${BASE_URL}/api/rooms`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ slug: `ho-room-${Date.now()}-${roomCounter}` }),
  });
  const body = await res.json();
  assert.ok(body.ok, JSON.stringify(body));
  return new URL(body.controlUrl).searchParams.get('token');
}

test.before(async () => {
  for (let i = 0; i < 20; i++) { try { await fetch(`${BASE_URL}/`); break; } catch { await sleep(100); } }
  apiKey = db.createClient('Handoff Test Client').apiKey;
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

test('REFRESH: the controller that reloads its page gets control back - the other panel is NOT promoted', async () => {
  const token = await createRoom();
  const a = await open(token, 'panel-A-0001', 'Laptop');
  let b = await open(token, 'panel-B-0001', 'Phone');
  b.socket.emit('requestControl'); await sleep(200);
  assert.ok(b.isController, 'B took control');

  b.socket.close();                              // page unloads...
  await sleep(120);
  b = await open(token, 'panel-B-0001', 'Phone'); // ...and the reloaded page reconnects with the same panel id
  await sleep(150);
  try {
    assert.ok(b.isController, 'B is still the controller after its refresh');
    assert.ok(!a.isController, 'A was not promoted');
    await sleep(GRACE_MS + 300);
    assert.ok(b.isController && !a.isController, 'and nothing changes once the grace period has passed');
  } finally { a.socket.close(); b.socket.close(); }
});

test('OVERLAP: a reconnect that arrives before the old connection is noticed gone still keeps control', async () => {
  const token = await createRoom();
  const a = await open(token, 'panel-A-0002');
  const bOld = await open(token, 'panel-B-0002');
  bOld.socket.emit('requestControl'); await sleep(200);
  const bNew = await open(token, 'panel-B-0002'); // new connection first (old one is a ghost)
  bOld.socket.close(); await sleep(GRACE_MS + 300);
  try {
    assert.ok(bNew.isController, 'the new connection holds control');
    assert.ok(!a.isController);
  } finally { a.socket.close(); bNew.socket.close(); }
});

test('GRACE: while the controller is away, others see "reconnecting" with its name, are not auto-promoted, and a newcomer is an observer', async () => {
  const token = await createRoom();
  const a = await open(token, 'panel-A-0003', 'Laptop');
  const b = await open(token, 'panel-B-0003', 'Phone');
  b.socket.emit('requestControl'); await sleep(200);
  b.socket.close(); await sleep(200);
  const c = await open(token, 'panel-C-0003', 'Tablet');
  try {
    assert.equal(a.status.activeControllerSocketId, null);
    assert.equal(a.status.reconnecting, true);
    assert.equal(a.status.activeControllerName, 'Phone');
    assert.ok(!a.isController && !c.isController, 'nobody takes the seat while it is reserved');
  } finally { a.socket.close(); c.socket.close(); }
});

test('GRACE: another panel can still Take Over at any time - nobody is ever locked out', async () => {
  const token = await createRoom();
  const a = await open(token, 'panel-A-0004');
  let b = await open(token, 'panel-B-0004');
  b.socket.emit('requestControl'); await sleep(200);
  b.socket.close(); await sleep(150);
  a.socket.emit('requestControl'); await sleep(200);
  assert.ok(a.isController, 'A took over during the grace period');
  b = await open(token, 'panel-B-0004'); // B comes back afterwards
  await sleep(GRACE_MS + 300);
  try {
    assert.ok(a.isController && !b.isController, 'B returning does not undo a deliberate Take Over');
  } finally { a.socket.close(); b.socket.close(); }
});

test('GRACE EXPIRY: a controller that never comes back hands over to a connected panel (previous behaviour, just deferred)', async () => {
  const token = await createRoom();
  const a = await open(token, 'panel-A-0005');
  const b = await open(token, 'panel-B-0005');
  b.socket.emit('requestControl'); await sleep(200);
  b.socket.close();
  await sleep(GRACE_MS + 400);
  try {
    assert.ok(a.isController, 'A promoted after the grace period');
    assert.equal(a.status.reconnecting, false);
  } finally { a.socket.close(); }
});

test('a page that sends no panel id cannot be recognised, so it keeps the old immediate hand-over', async () => {
  const token = await createRoom();
  const a = await open(token, 'panel-A-0006');
  const b = await open(token); // no panelId
  b.socket.emit('requestControl'); await sleep(200);
  b.socket.close(); await sleep(250);
  try {
    assert.ok(a.isController, 'promoted straight away - there is nothing to wait for');
  } finally { a.socket.close(); }
});

test('the only panel refreshing after the grace period simply claims the empty seat', async () => {
  const token = await createRoom();
  let a = await open(token, 'panel-A-0007');
  assert.ok(a.isController);
  a.socket.close(); await sleep(GRACE_MS + 300);
  a = await open(token, 'panel-A-0007');
  try { assert.ok(a.isController); } finally { a.socket.close(); }
});

test('SAME DEVICE, NEW TAB: closing the controller tab and opening the link again on that device gets the seat back', async () => {
  const token = await createRoom();
  const a = await open(token, 'panel-A-0008', 'Laptop', 'device-A-0008');
  let b = await open(token, 'panel-B-0008', 'Phone', 'device-B-0008');
  b.socket.emit('requestControl'); await sleep(200);
  b.socket.close(); await sleep(200);
  b = await open(token, 'panel-B-NEWTAB', 'Phone', 'device-B-0008'); // new tab = new panel id, same device
  await sleep(150);
  try {
    assert.ok(b.isController, 'recognised by device id');
    assert.ok(!a.isController);
  } finally { a.socket.close(); b.socket.close(); }
});

test('SAME DEVICE, SECOND TAB alongside the first: it does NOT take control from the open tab', async () => {
  const token = await createRoom();
  const tab1 = await open(token, 'panel-T1-0009', 'Laptop', 'device-X-0009');
  const tab2 = await open(token, 'panel-T2-0009', 'Laptop', 'device-X-0009');
  try {
    assert.ok(tab1.isController, 'first tab keeps control');
    assert.ok(!tab2.isController, 'second tab is an observer while the first is connected');
  } finally { tab1.socket.close(); tab2.socket.close(); }
});

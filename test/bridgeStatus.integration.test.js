'use strict';

// Integration: the REAL server.js, booted in-process against a scratch
// SQLite database, driven by REAL socket.io-client connections using real
// control/display tokens obtained through the real POST /api/rooms endpoint.
// This proves the P2.1 wiring (not just the bridgeStatus.js registry module,
// which has its own isolated unit tests in bridgeStatus.unit.test.js):
// tenancy/room isolation, disconnect cleanup, spoof attempts, multiple
// bridges, the initial-snapshot-on-connect behaviour, and that the existing
// display-token read-only guarantee still holds with the one narrow,
// deliberate exception this feature adds.
//
// server.js exports nothing and has no close() of its own; this file
// intercepts http.createServer() to capture the instance it creates so it
// can be shut down cleanly in test.after().

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const { io: ioClient } = require('socket.io-client');

const PORT = 3958;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const scratchDbPath = path.join(os.tmpdir(), `pt-bridgestatus-test-${Date.now()}-${process.pid}.sqlite`);
process.env.DATABASE_PATH = scratchDbPath;
process.env.PORT = String(PORT);
// Isolate from the repo's own (legacy, unrelated) rooms.json - this scratch
// DB must start completely empty, not import unrelated real data.
process.env.LEGACY_ROOMS_JSON_PATH = path.join(os.tmpdir(), `pt-bridgestatus-test-no-such-file-${Date.now()}.json`);

const db = require('../db');

let capturedServer = null;
const originalCreateServer = http.createServer.bind(http);
http.createServer = (...args) => {
  capturedServer = originalCreateServer(...args);
  return capturedServer;
};
require('../server'); // side-effecting: boots the real app + listens on PORT
http.createServer = originalCreateServer;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForEvent(socket, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for '${event}'`)), timeoutMs);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
}

// Connects and returns { socket, ready }, where `ready` resolves with the
// initial 'timerState' payload. The listener for it is attached synchronously
// at socket creation - BEFORE any await - so it can never race the server's
// immediate post-handshake emit (a listener attached only after awaiting
// 'connect' can miss an event that already arrived).
function connectAs(token) {
  const socket = ioClient(BASE_URL, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for initial timerState')), 3000);
    socket.once('timerState', (state) => { clearTimeout(timer); resolve(state); });
    socket.once('connect_error', (err) => { clearTimeout(timer); reject(err); });
  });
  return { socket, ready };
}

function validHeartbeat(over = {}) {
  return {
    v: 1,
    bridgeId: 'aabbccdd11223344',
    bridgeVersion: '0.2.0-test',
    overall: 'live',
    reason: 'Live - following room "test"',
    output: 'running',
    ptConnected: true,
    interfaceName: 'TestNIC',
    ...over,
  };
}

let apiKey;
let roomCounter = 0;

async function createRoom() {
  roomCounter += 1;
  const slug = `bs-test-room-${Date.now()}-${roomCounter}`;
  const res = await fetch(`${BASE_URL}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ slug }),
  });
  const body = await res.json();
  assert.ok(body.ok, `room creation failed: ${JSON.stringify(body)}`);
  return {
    controlToken: new URL(body.controlUrl).searchParams.get('token'),
    displayToken: new URL(body.displayUrl).searchParams.get('token'),
  };
}

test.before(async () => {
  // Wait for the server to actually be listening before hammering it.
  for (let i = 0; i < 20; i++) {
    try {
      await fetch(`${BASE_URL}/`);
      break;
    } catch {
      await sleep(100);
    }
  }
  const client = db.createClient('P2.1 Test Client');
  apiKey = client.apiKey;
});

test.after(async () => {
  await new Promise((resolve) => {
    if (!capturedServer) return resolve();
    if (typeof capturedServer.closeAllConnections === 'function') capturedServer.closeAllConnections();
    capturedServer.close(() => resolve());
  });
  try { fs.unlinkSync(scratchDbPath); } catch { /* ignore */ }
  try { fs.unlinkSync(scratchDbPath + '-wal'); } catch { /* ignore */ }
  try { fs.unlinkSync(scratchDbPath + '-shm'); } catch { /* ignore */ }
  // server.js has its own top-level, non-unref'd `setInterval` (the 1 Hz
  // timer tick) that keeps the event loop alive forever by design - correct
  // for its normal long-running server process, but it means closing the
  // HTTP server alone can never let an in-process test exit on its own.
  process.exit(0);
});

test('a display-role socket reporting bridgeStatus reaches a control-role socket in the SAME room', async () => {
  const { controlToken, displayToken } = await createRoom();
  const control = connectAs(controlToken);
  const bridge = connectAs(displayToken);
  try {
    await Promise.all([control.ready, bridge.ready]);

    const updatePromise = waitForEvent(control.socket, 'bridgeStatusUpdate');
    bridge.socket.emit('bridgeStatus', validHeartbeat());
    const status = await updatePromise;

    assert.equal(status.overall, 'live');
    assert.equal(status.sources, 1);
  } finally {
    control.socket.close();
    bridge.socket.close();
  }
});

test('a bridgeStatus report for room A never reaches a control socket in room B (tenancy / room isolation)', async () => {
  const roomA = await createRoom();
  const roomB = await createRoom();
  const controlA = connectAs(roomA.controlToken);
  const controlB = connectAs(roomB.controlToken);
  const bridgeA = connectAs(roomA.displayToken);
  try {
    await Promise.all([controlA.ready, controlB.ready, bridgeA.ready]);

    let controlBSawUpdate = false;
    controlB.socket.on('bridgeStatusUpdate', () => { controlBSawUpdate = true; });

    const updatePromise = waitForEvent(controlA.socket, 'bridgeStatusUpdate');
    bridgeA.socket.emit('bridgeStatus', validHeartbeat());
    await updatePromise;

    await sleep(150); // give a wrongly-broadcast event a chance to arrive
    assert.equal(controlBSawUpdate, false, 'room B must never see room A\'s bridge status');
  } finally {
    controlA.socket.close();
    controlB.socket.close();
    bridgeA.socket.close();
  }
});

test('a spoofed roomId inside the payload is ignored - status is still attributed to the connection\'s own room', async () => {
  const roomA = await createRoom();
  const roomB = await createRoom();
  const controlA = connectAs(roomA.controlToken);
  const controlB = connectAs(roomB.controlToken);
  const bridgeA = connectAs(roomA.displayToken);
  try {
    await Promise.all([controlA.ready, controlB.ready, bridgeA.ready]);

    let controlBSawUpdate = false;
    controlB.socket.on('bridgeStatusUpdate', () => { controlBSawUpdate = true; });

    const updatePromise = waitForEvent(controlA.socket, 'bridgeStatusUpdate');
    // Attempt to claim room B's identity from inside the payload itself.
    bridgeA.socket.emit('bridgeStatus', validHeartbeat({ roomId: 'roomB-id-guess', room: 'roomB' }));
    const status = await updatePromise;

    assert.equal(status.overall, 'live', 'room A still gets its own status');
    await sleep(150);
    assert.equal(controlBSawUpdate, false, 'the payload-supplied room claim must be ignored entirely');
  } finally {
    controlA.socket.close();
    controlB.socket.close();
    bridgeA.socket.close();
  }
});

test('a malformed bridgeStatus payload is dropped without crashing the socket or affecting existing status', async () => {
  const { controlToken, displayToken } = await createRoom();
  const control = connectAs(controlToken);
  const bridge = connectAs(displayToken);
  try {
    await Promise.all([control.ready, bridge.ready]);

    const goodUpdate = waitForEvent(control.socket, 'bridgeStatusUpdate');
    bridge.socket.emit('bridgeStatus', validHeartbeat());
    await goodUpdate;

    let sawAnotherUpdate = false;
    control.socket.on('bridgeStatusUpdate', () => { sawAnotherUpdate = true; });

    bridge.socket.emit('bridgeStatus', { overall: 'live' }); // missing required fields
    bridge.socket.emit('bridgeStatus', 'not even an object');
    bridge.socket.emit('bridgeStatus', { v: 1, overall: 'nonsense-state', output: 'running', ptConnected: true });
    await sleep(150);

    assert.equal(sawAnotherUpdate, false, 'invalid payloads must not produce a broadcast');
    assert.equal(bridge.socket.connected, true, 'the socket must not be disconnected by a malformed payload');
  } finally {
    control.socket.close();
    bridge.socket.close();
  }
});

test('a control-role socket sending bridgeStatus is ignored (structural read-only guarantee)', async () => {
  const { controlToken } = await createRoom();
  const control = connectAs(controlToken);
  try {
    await control.ready;

    let sawUpdate = false;
    control.socket.on('bridgeStatusUpdate', () => { sawUpdate = true; });
    control.socket.emit('bridgeStatus', validHeartbeat());
    await sleep(150);

    assert.equal(sawUpdate, false, 'a control-role socket must not be able to publish Physical Display Output status');
  } finally {
    control.socket.close();
  }
});

test('disconnecting the bridge socket clears its status immediately (not waiting for the stale sweep)', async () => {
  const { controlToken, displayToken } = await createRoom();
  const control = connectAs(controlToken);
  const bridge = connectAs(displayToken);
  try {
    await Promise.all([control.ready, bridge.ready]);

    const liveUpdate = waitForEvent(control.socket, 'bridgeStatusUpdate');
    bridge.socket.emit('bridgeStatus', validHeartbeat());
    const live = await liveUpdate;
    assert.equal(live.overall, 'live');

    const offUpdate = waitForEvent(control.socket, 'bridgeStatusUpdate');
    bridge.socket.close();
    const off = await offUpdate;
    assert.equal(off.overall, 'off');
    assert.equal(off.sources, 0);
  } finally {
    control.socket.close();
    if (bridge.socket.connected) bridge.socket.close();
  }
});

test('a freshly-connecting control socket immediately learns the current status - not only future heartbeats', async () => {
  const { controlToken, displayToken } = await createRoom();
  const bridge = connectAs(displayToken);
  try {
    await bridge.ready;
    // No control socket is connected yet when this heartbeat is sent.
    bridge.socket.emit('bridgeStatus', validHeartbeat());
    await sleep(150);

    const lateControl = connectAs(controlToken);
    try {
      const statusPromise = waitForEvent(lateControl.socket, 'bridgeStatusUpdate');
      await lateControl.ready;
      const status = await statusPromise;
      assert.equal(status.overall, 'live', 'a page opened after the bridge was already running sees the current status right away');
    } finally {
      lateControl.socket.close();
    }
  } finally {
    bridge.socket.close();
  }
});

test('two simultaneous bridges for one room are surfaced as an honest "multiple sources" degraded warning', async () => {
  const { controlToken, displayToken } = await createRoom();
  const control = connectAs(controlToken);
  const bridge1 = connectAs(displayToken);
  const bridge2 = connectAs(displayToken);
  try {
    await Promise.all([control.ready, bridge1.ready, bridge2.ready]);

    const firstUpdate = waitForEvent(control.socket, 'bridgeStatusUpdate');
    bridge1.socket.emit('bridgeStatus', validHeartbeat({ bridgeId: '1111111111111111' }));
    await firstUpdate;

    const secondUpdate = waitForEvent(control.socket, 'bridgeStatusUpdate');
    bridge2.socket.emit('bridgeStatus', validHeartbeat({ bridgeId: '2222222222222222' }));
    const status = await secondUpdate;

    assert.equal(status.overall, 'degraded');
    assert.equal(status.sources, 2);
    assert.match(status.reason, /2 Physical Display Output sources/);
  } finally {
    control.socket.close();
    bridge1.socket.close();
    bridge2.socket.close();
  }
});

test('a room with no bridge ever connected shows no status at all', async () => {
  const { controlToken } = await createRoom();
  const control = connectAs(controlToken);
  try {
    await control.ready;
    let sawUpdate = false;
    control.socket.on('bridgeStatusUpdate', () => { sawUpdate = true; });
    await sleep(200);
    assert.equal(sawUpdate, false);
  } finally {
    control.socket.close();
  }
});

test('a display-role socket still cannot mutate the timer (existing read-only guarantee holds alongside the new event)', async () => {
  const { controlToken, displayToken } = await createRoom();
  const control = connectAs(controlToken);
  const bridge = connectAs(displayToken);
  try {
    const [initial] = await Promise.all([control.ready, bridge.ready]);
    assert.equal(initial.mode, 'stopped');

    let sawTimerStateAfterMutationAttempt = false;
    control.socket.on('timerState', () => { sawTimerStateAfterMutationAttempt = true; });

    bridge.socket.emit('startTimer', { durationMs: 60000 });
    bridge.socket.emit('bridgeStatus', validHeartbeat()); // the one thing it IS allowed to send
    await waitForEvent(control.socket, 'bridgeStatusUpdate');

    assert.equal(sawTimerStateAfterMutationAttempt, false, 'a display-role startTimer attempt must not change room state');
  } finally {
    control.socket.close();
    bridge.socket.close();
  }
});

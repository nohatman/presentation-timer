'use strict';

// Integration: real PtClient <-> real socket.io server <-> real BridgeEngine
// <-> real UDP socket <-> real dgram listener. Only the Presentation Timer
// *business logic* is faked; lib/state.js does the real remaining-time maths and
// is unit-tested separately against display.html semantics.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const dgram = require('node:dgram');
const { Server } = require('socket.io');

const { PtClient } = require('../lib/ptClient');
const { BridgeEngine } = require('../lib/engine');
const { StatusModel } = require('../lib/status');
const { RingLog } = require('../lib/log');
const { deriveFrame } = require('../lib/state');
const { UdpSender, OFF_FRAME } = require('../lib/cdether');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');

function baseState(over = {}) {
  return {
    mode: 'running', durationMs: 600000, startTime: Date.now() - 60000,
    pauseTime: null, accumulatedPauseMs: 0, speed: 1.0,
    amberThresholdMs: 300000, redThresholdMs: 120000,
    countUp: false, showClock: false, outputMode: 'timer',
    message: '', messageMode: 'none', ...over,
  };
}

// --- fake Presentation Timer server (display-role subset of server.js) ---
async function startFakePt() {
  const httpServer = http.createServer();
  const io = new Server(httpServer, { cors: { origin: '*' } });
  const state = { current: baseState() };
  const clientEmits = [];

  io.on('connection', (socket) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (token === 'BAD') {
      socket.emit('authError', { message: 'Invalid or expired link.' });
      socket.disconnect(true);
      return;
    }
    // anything the client emits (other than the handshake) is a read-only violation
    socket.onAny((ev) => clientEmits.push(ev));
    socket.join('room');
    socket.emit('timerState', { ...state.current, serverNow: Date.now(), roomInfo: { slug: 'BALLROOM' } });
  });

  await new Promise((res) => httpServer.listen(0, '127.0.0.1', res));
  const url = `http://127.0.0.1:${httpServer.address().port}`;

  return {
    url,
    clientEmits,
    push(over) {
      state.current = baseState(over);
      io.to('room').emit('timerState', { ...state.current, serverNow: Date.now() });
    },
    bootEveryone() {
      for (const s of io.sockets.sockets.values()) s.disconnect(true); // -> 'io server disconnect'
    },
    async close() {
      io.close();
      await new Promise((res) => httpServer.close(res));
    },
  };
}

async function startUdpListener() {
  const rx = dgram.createSocket('udp4');
  const frames = [];
  rx.on('message', (m) => frames.push(hex(m)));
  await new Promise((res) => rx.bind(0, '127.0.0.1', res));
  return { port: rx.address().port, frames, close: () => rx.close() };
}

function buildEngine(ptUrl, udpPort, token = 'GOOD') {
  const pt = new PtClient({ serverUrl: ptUrl, displayToken: token });
  const sender = new UdpSender({ address: '127.0.0.1', port: udpPort, bindAddress: '127.0.0.1' });
  const engine = new BridgeEngine({
    ptClient: pt, sender, status: new StatusModel(), log: new RingLog(), deriveFrame,
    options: { frameIntervalMs: 40, serverRetryMs: 60 },
  });
  return { pt, sender, engine };
}

test('end-to-end: subscribe, follow countdown, reflect state changes, read-only', async (t) => {
  const ptServer = await startFakePt();
  const udp = await startUdpListener();
  const { sender, engine } = buildEngine(ptServer.url, udp.port);
  await sender.ready;
  t.after(async () => { await engine.dispose(); udp.close(); await ptServer.close(); });

  engine.connect();
  engine.start();
  await sleep(200);

  assert.equal(engine.snapshot.pt.state, 'connected');
  assert.equal(engine.snapshot.pt.room, 'BALLROOM');
  assert.equal(engine.snapshot.overall.state, 'live');
  assert.ok(udp.frames.length >= 3, `frames flowing (${udp.frames.length})`);
  assert.ok(udp.frames.every((f) => f.endsWith(' 01')), 'green while > amber threshold');

  // Push a state near the red threshold -> frames should turn red (0x02)
  ptServer.push({ startTime: Date.now() - (600000 - 60000) }); // 60s left, red threshold 120s
  await sleep(150);
  assert.ok(udp.frames.at(-1).endsWith(' 02'), `red near end, got ${udp.frames.at(-1)}`);

  assert.deepEqual(ptServer.clientEmits, [], 'bridge emitted nothing to the server (structurally read-only)');
});

test('end-to-end: intentional stop sends exactly one OFF then silence', async (t) => {
  const ptServer = await startFakePt();
  const udp = await startUdpListener();
  const { sender, engine } = buildEngine(ptServer.url, udp.port);
  await sender.ready;
  t.after(async () => { await engine.dispose(); udp.close(); await ptServer.close(); });

  engine.connect();
  engine.start();
  await sleep(150);
  await engine.stop();
  await sleep(20);
  const n = udp.frames.length;
  assert.equal(udp.frames.at(-1), hex(OFF_FRAME), 'last frame is OFF');
  await sleep(120);
  assert.equal(udp.frames.length, n, 'no frames after stop');
});

test('end-to-end: server closes the socket -> no OFF, then auto-retry resumes', async (t) => {
  const ptServer = await startFakePt();
  const udp = await startUdpListener();
  const { sender, engine } = buildEngine(ptServer.url, udp.port);
  await sender.ready;
  t.after(async () => { await engine.dispose(); udp.close(); await ptServer.close(); });

  engine.connect();
  engine.start();
  await sleep(150);
  const n = udp.frames.length;

  ptServer.bootEveryone(); // -> 'io server disconnect'
  await sleep(30);
  assert.equal(engine.snapshot.pt.state, 'room-unavailable');
  assert.ok(!udp.frames.includes(hex(OFF_FRAME)), 'no OFF frame is ever attempted on unexpected loss');

  // The engine drives manual reconnection (socket.io will not); the fake server
  // still accepts connections, so output should resume on its own.
  await sleep(250);
  assert.ok(udp.frames.length > n, 'resumed after automatic reconnection');
  assert.ok(!udp.frames.includes(hex(OFF_FRAME)), 'still no OFF frame after recovery');
  assert.equal(engine.snapshot.overall.state, 'live');
});

test('end-to-end: bad token -> best-effort OFF + fatal', async (t) => {
  const ptServer = await startFakePt();
  const udp = await startUdpListener();
  const { sender, engine } = buildEngine(ptServer.url, udp.port, 'BAD');
  await sender.ready;
  t.after(async () => { await engine.dispose(); udp.close(); await ptServer.close(); });

  const fatal = new Promise((res) => engine.once('fatal', res));
  engine.connect();
  engine.start();
  await fatal;
  await sleep(30);
  assert.equal(udp.frames.at(-1), hex(OFF_FRAME), 'best-effort OFF while the path still exists');
  assert.equal(engine.snapshot.pt.state, 'auth-failed');
  assert.equal(engine.snapshot.overall.state, 'error');
});

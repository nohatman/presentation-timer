'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { BridgeEngine } = require('../lib/engine');
const { StatusModel } = require('../lib/status');
const { RingLog } = require('../lib/log');
const { deriveFrame } = require('../lib/state');
const { OFF_FRAME } = require('../lib/cdether');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');

function runningState(over = {}) {
  return {
    mode: 'running',
    durationMs: 600000,
    startTime: Date.now() - 60000,
    pauseTime: null,
    accumulatedPauseMs: 0,
    speed: 1.0,
    amberThresholdMs: 300000,
    redThresholdMs: 120000,
    countUp: false,
    showClock: false,
    outputMode: 'timer',
    message: '',
    messageMode: 'none',
    serverNow: Date.now(),
    roomInfo: { slug: 'TESTROOM' },
    ...over,
  };
}

class FakePt extends EventEmitter {
  constructor() {
    super();
    this.lastState = null;
    this.clockOffsetMs = 0;
    this.started = false;
    this.stopped = false;
    this.reconnects = 0;
    this.connected = false;   // P2.1: mirrors socket.connected for sendStatus()
    this.statusSent = [];     // P2.1: every payload passed to sendStatus()
  }
  start() { this.started = true; this.emit('connecting'); }
  reconnect() { this.reconnects++; this.emit('connecting'); }
  stop() { this.stopped = true; this.connected = false; }

  // P2.1: mirrors PtClient.sendStatus() - no-op while "disconnected".
  sendStatus(payload) {
    if (!this.connected) return false;
    this.statusSent.push(payload);
    return true;
  }

  // helpers used by tests
  arrive(state = runningState()) {
    this.connected = true;
    this.lastState = state;
    this.emit('connected');
    this.emit('state', state, this.clockOffsetMs);
  }
  dropUnexpected(reason = 'transport close') {
    this.connected = false;
    this.lastState = null;
    this.emit('disconnected', { reason, intentional: false, serverInitiated: false });
  }
  dropServerInitiated() {
    this.connected = false;
    this.lastState = null;
    this.emit('disconnected', { reason: 'io server disconnect', intentional: false, serverInitiated: true });
  }
}

class FakeSender {
  constructor() { this.sent = []; this.failNext = false; this.failAll = false; }
  async send(buf) {
    this.sent.push(Buffer.from(buf));
    if (this.failAll || this.failNext) {
      this.failNext = false;
      return { ok: false, error: new Error('ENETUNREACH') };
    }
    return { ok: true, error: null };
  }
  async close() {}
}

function makeEngine(opts = {}) {
  const pt = new FakePt();
  const sender = new FakeSender();
  const status = new StatusModel();
  const engine = new BridgeEngine({
    ptClient: pt, sender, status, log: new RingLog(), deriveFrame,
    options: { frameIntervalMs: 20, serverRetryMs: 40, ...opts },
  });
  return { pt, sender, status, engine };
}

test('1 Hz loop: transmits repeatedly while connected and running', async () => {
  const { pt, sender, engine } = makeEngine();
  engine.connect();
  engine.start();
  pt.arrive();
  await sleep(90);
  await engine.dispose();
  assert.ok(sender.sent.length >= 3, `expected >=3 frames, got ${sender.sent.length}`);
  // frames are timer frames (byte 3 = 0x01 green here), not OFF
  assert.equal(sender.sent[1][2], 0x01);
});

test('intentional stop(): sends exactly one OFF, then silence', async () => {
  const { pt, sender, engine } = makeEngine({ frameIntervalMs: 1000 });
  engine.connect();
  engine.start();
  pt.arrive();
  await sleep(30);                 // one immediate frame
  const beforeStop = sender.sent.length;
  await engine.stop();
  const afterStop = sender.sent.length;
  assert.equal(afterStop - beforeStop, 1, 'exactly one frame sent during stop()');
  assert.equal(hex(sender.sent.at(-1)), hex(OFF_FRAME), 'last frame is OFF');
  await sleep(60);
  assert.equal(sender.sent.length, afterStop, 'no frames after stop()');
  assert.equal(engine.snapshot.overall.state, 'idle');
  await engine.dispose();
});

test('unexpected disconnect: ceases, sends NO OFF, status degraded', async () => {
  const { pt, sender, engine } = makeEngine();
  engine.connect();
  engine.start();
  pt.arrive();
  await sleep(60);
  const count = sender.sent.length;
  pt.dropUnexpected();
  await sleep(80);
  assert.equal(sender.sent.length, count, 'no further frames, and NO OFF, after unexpected loss');
  assert.equal(engine.snapshot.overall.state, 'degraded');
  assert.match(engine.snapshot.overall.reason, /holding its last value/i);
  await engine.dispose();
});

test('reconnect: resumes from fresh authoritative state', async () => {
  const { pt, sender, engine } = makeEngine();
  engine.connect();
  engine.start();
  pt.arrive();
  await sleep(50);
  pt.dropUnexpected();
  await sleep(50);
  const atLoss = sender.sent.length;
  pt.arrive(runningState({ startTime: Date.now() - 5000 })); // fresh anchor
  await sleep(80);
  assert.ok(sender.sent.length > atLoss, 'transmission resumed after fresh state');
  assert.equal(engine.snapshot.overall.state, 'live');
  await engine.dispose();
});

test('UDP send failure: overall error; recovers when sends succeed again', async () => {
  const { pt, sender, engine } = makeEngine();
  engine.connect();
  engine.start();
  pt.arrive();
  await sleep(30);
  sender.failAll = true;
  await sleep(50);
  assert.equal(engine.snapshot.overall.state, 'error');
  assert.match(engine.snapshot.overall.reason, /ENETUNREACH|not sending/i);
  sender.failAll = false;
  await sleep(60);
  assert.equal(engine.snapshot.overall.state, 'live', 'recovers after sends succeed');
  await engine.dispose();
});

test('fatal (auth): best-effort OFF, emits fatal, status auth-failed', async () => {
  const { pt, sender, engine } = makeEngine();
  engine.connect();
  engine.start();
  pt.arrive();
  await sleep(30);
  const fatalSeen = new Promise((res) => engine.once('fatal', res));
  pt.emit('fatal', new Error('Display token rejected: expired'));
  await fatalSeen;
  assert.equal(hex(sender.sent.at(-1)), hex(OFF_FRAME), 'best-effort OFF attempted');
  assert.equal(engine.snapshot.pt.state, 'auth-failed');
  assert.equal(engine.snapshot.overall.state, 'error');
  await engine.dispose();
});

test('server-initiated disconnect: room-unavailable + periodic reconnect', async () => {
  const { pt, engine } = makeEngine({ serverRetryMs: 30 });
  engine.connect();
  engine.start();
  pt.arrive();
  await sleep(20);
  pt.dropServerInitiated();
  assert.equal(engine.snapshot.pt.state, 'room-unavailable');
  assert.equal(engine.snapshot.overall.state, 'error');
  await sleep(80);
  assert.ok(pt.reconnects >= 1, 'engine drove at least one manual reconnect');
  await engine.dispose();
});

test('clock mode (P1.1) -> HH:MM green frames each tick, not OFF', async () => {
  const { pt, sender, engine } = makeEngine();
  engine.connect();
  engine.start();
  pt.arrive(runningState({ showClock: true }));
  await sleep(60);
  const duringClockMode = sender.sent.slice();
  await engine.dispose();
  assert.ok(duringClockMode.length >= 2, 'frames were sent while in clock mode');
  assert.ok(duringClockMode.every((b) => b[2] === 0x01), 'every clock-mode frame is green (0x01), none are OFF');
  // dispose() still sends its own best-effort OFF afterward (intentional-stop
  // semantics are unrelated to, and unaffected by, clock mode).
  assert.equal(hex(sender.sent.at(-1)), hex(OFF_FRAME));
});

test('dispose while output active sends a best-effort OFF', async () => {
  const { pt, sender, engine } = makeEngine();
  engine.connect();
  engine.start();
  pt.arrive();
  await sleep(30);
  await engine.dispose();
  assert.equal(hex(sender.sent.at(-1)), hex(OFF_FRAME));
  assert.ok(pt.stopped);
});

// ---- P2.1: bridge -> Presentation Timer status heartbeat ----

test('heartbeat: reports a status on every StatusModel change', async () => {
  const { pt, engine } = makeEngine();
  engine.connect();
  pt.arrive(); // status.setPt('connected', ...) -> a 'change'
  await sleep(10);
  assert.ok(pt.statusSent.length > 0, 'at least one status reported on a state transition');
  const last = pt.statusSent.at(-1);
  assert.equal(last.v, 1);
  assert.ok(['off', 'connecting', 'live', 'degraded', 'error'].includes(last.overall));
  await engine.dispose();
});

test('heartbeat: also fires on a fixed interval even with no state change', async () => {
  const { pt, engine } = makeEngine({ heartbeatIntervalMs: 20 });
  engine.connect();
  pt.arrive();
  await sleep(15);
  const countAfterChange = pt.statusSent.length;
  await sleep(60); // no further state changes; the interval alone should add more
  assert.ok(pt.statusSent.length > countAfterChange, 'unconditional heartbeat keeps reporting on a steady state');
  await engine.dispose();
});

test('heartbeat: silently does nothing while the PT connection is down (no throw, no queue)', async () => {
  const { pt, engine } = makeEngine({ heartbeatIntervalMs: 20 });
  engine.connect(); // pt.connected stays false until arrive()
  await sleep(50);
  assert.equal(pt.statusSent.length, 0, 'no heartbeat sent while disconnected');
  await engine.dispose();
});

test('heartbeat payload carries the configured bridgeId/bridgeVersion/interface', async () => {
  const { pt, engine } = makeEngine({ bridgeId: 'abc123', bridgeVersion: '9.9.9', getInterfaceName: () => 'Ethernet' });
  engine.connect();
  pt.arrive();
  await sleep(10);
  const last = pt.statusSent.at(-1);
  assert.equal(last.bridgeId, 'abc123');
  assert.equal(last.bridgeVersion, '9.9.9');
  assert.equal(last.interfaceName, 'Ethernet');
  await engine.dispose();
});

test('heartbeat stops after dispose()', async () => {
  const { pt, engine } = makeEngine({ heartbeatIntervalMs: 15 });
  engine.connect();
  pt.arrive();
  await sleep(10);
  await engine.dispose();
  pt.connected = true; // simulate the socket staying nominally "up" post-dispose
  const before = pt.statusSent.length;
  await sleep(60);
  assert.equal(pt.statusSent.length, before, 'no further heartbeats fire once disposed');
});

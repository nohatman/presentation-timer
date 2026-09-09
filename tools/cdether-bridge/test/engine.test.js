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
  }
  start() { this.started = true; this.emit('connecting'); }
  reconnect() { this.reconnects++; this.emit('connecting'); }
  stop() { this.stopped = true; }

  // helpers used by tests
  arrive(state = runningState()) {
    this.lastState = state;
    this.emit('connected');
    this.emit('state', state, this.clockOffsetMs);
  }
  dropUnexpected(reason = 'transport close') {
    this.lastState = null;
    this.emit('disconnected', { reason, intentional: false, serverInitiated: false });
  }
  dropServerInitiated() {
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

test('clock mode -> OFF frames each tick (path is up)', async () => {
  const { pt, sender, engine } = makeEngine();
  engine.connect();
  engine.start();
  pt.arrive(runningState({ showClock: true }));
  await sleep(60);
  await engine.dispose();
  const timerFrames = sender.sent.filter((b) => b[2] !== 0x04);
  assert.equal(timerFrames.length, 0, 'all frames are OFF while in clock mode');
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

'use strict';

// Integration: real server.js in-process (same harness pattern as
// bridgeStatus.integration.test.js) driven by real socket.io-client
// connections and the real REST (Companion) routes. Proves the Duration /
// End-at mode model end to end: Socket.IO commands, REST parity for
// Companion, reconnect resync, persistence, and that the existing state
// contract (mode/durationMs/startTime/...) is unchanged for display/CDEther.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const { io: ioClient } = require('socket.io-client');

const PORT = 3959;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const MIN = 60000;

const scratchDbPath = path.join(os.tmpdir(), `pt-timermodes-test-${Date.now()}-${process.pid}.sqlite`);
process.env.DATABASE_PATH = scratchDbPath;
process.env.PORT = String(PORT);
process.env.LEGACY_ROOMS_JSON_PATH = path.join(os.tmpdir(), `pt-timermodes-test-no-such-file-${Date.now()}.json`);

// The in-process server logs every join/leave. Interleaved with the test runner's own result
// frames on stdout that noise can corrupt them ("Unable to deserialize cloned data"), so keep it quiet.
const realConsoleLog = console.log;
console.log = () => {};

const db = require('../db');

let capturedServer = null;
const originalCreateServer = http.createServer.bind(http);
http.createServer = (...args) => { capturedServer = originalCreateServer(...args); return capturedServer; };
require('../server');
http.createServer = originalCreateServer;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Operator wall-clock HH:MM `minutes` from now, plus the matching UTC offset.
function targetInMinutes(minutes) {
  const d = new Date(Date.now() + minutes * MIN + 20000); // +20s so the minute boundary can't bite
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
const tz = () => new Date().getTimezoneOffset();

function connectControl(token) {
  const socket = ioClient(BASE_URL, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
  let latest = null;
  const waiters = [];
  socket.on('timerState', (s) => { latest = s; while (waiters.length) waiters.shift()(s); });
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no initial timerState')), 3000);
    socket.once('timerState', (s) => { clearTimeout(t); resolve(s); });
    socket.once('connect_error', reject);
  });
  // Emit a command and resolve with the next state broadcast it causes.
  const send = (event, payload) => new Promise((resolve) => { waiters.push(resolve); socket.emit(event, payload); });
  return { socket, ready, send, get state() { return latest; } };
}

let apiKey; let roomCounter = 0;
async function createRoom() {
  roomCounter += 1;
  const slug = `tm-room-${Date.now()}-${roomCounter}`;
  const res = await fetch(`${BASE_URL}/api/rooms`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ slug }),
  });
  const body = await res.json();
  assert.ok(body.ok, JSON.stringify(body));
  return { slug, controlToken: new URL(body.controlUrl).searchParams.get('token'), displayToken: new URL(body.displayUrl).searchParams.get('token') };
}
async function rest(room, method, route, body) {
  const res = await fetch(`${BASE_URL}/api/rooms/${room.slug}/${route}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}
async function newControl() {
  const room = await createRoom();
  const c = connectControl(room.controlToken);
  await c.ready;
  return { room, c };
}

test.before(async () => {
  for (let i = 0; i < 20; i++) { try { await fetch(`${BASE_URL}/`); break; } catch { await sleep(100); } }
  apiKey = db.createClient('Timer Modes Test Client').apiKey;
});

test.after(async () => {
  await new Promise((resolve) => {
    if (!capturedServer) return resolve();
    if (typeof capturedServer.closeAllConnections === 'function') capturedServer.closeAllConnections();
    capturedServer.close(() => resolve());
  });
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(scratchDbPath + suffix); } catch { /* ignore */ } }
  // server.js's 1 Hz interval is not unref'd (see bridgeStatus test), so exit explicitly - but after
  // a beat, so the test runner's result stream is flushed first (an immediate exit can truncate it).
  setTimeout(() => process.exit(0), 300);
});

test('a brand-new room defaults to Duration mode and exposes the new fields additively', async () => {
  const { c } = await newControl();
  try {
    const s = c.state;
    assert.equal(s.timerMode, 'duration');
    assert.equal(s.mode, 'stopped');
    assert.equal(s.durationMs, 30 * MIN);
    assert.equal(s.configDurationMs, 30 * MIN);
    assert.equal(s.endAtTarget, null);
    // existing contract for display/CDEther/Companion is intact
    for (const k of ['mode', 'durationMs', 'startTime', 'pauseTime', 'accumulatedPauseMs', 'speed', 'amberThresholdMs', 'redThresholdMs', 'countUp', 'outputMode', 'rundown', 'rundownIndex', 'serverNow']) {
      assert.ok(k in s, `state.${k} missing`);
    }
  } finally { c.socket.close(); }
});

test('Duration: set 10:00, Start, Pause, Resume, Reset returns to 10:00', async () => {
  const { c } = await newControl();
  try {
    let s = await c.send('updateSettings', { durationMs: 10 * MIN });
    assert.equal(s.durationMs, 10 * MIN);
    s = await c.send('startTimer', { timerMode: 'duration', durationMs: 10 * MIN });
    assert.equal(s.mode, 'running'); assert.equal(s.durationMs, 10 * MIN); assert.ok(s.startTime);
    s = await c.send('pauseTimer'); assert.equal(s.mode, 'paused');
    s = await c.send('resumeTimer'); assert.equal(s.mode, 'running');
    s = await c.send('nudgeTimer', 2 * MIN); assert.equal(s.durationMs, 12 * MIN);
    s = await c.send('resetTimer');
    assert.equal(s.mode, 'stopped'); assert.equal(s.startTime, null);
    assert.equal(s.durationMs, 10 * MIN);
    // change after reset
    s = await c.send('updateSettings', { durationMs: 15 * MIN });
    assert.equal(s.durationMs, 15 * MIN);
  } finally { c.socket.close(); }
});

test('End at: server resolves the target from the clock + operator offset; Reset keeps End at', async () => {
  const { c } = await newControl();
  try {
    const target = targetInMinutes(10);
    let s = await c.send('updateSettings', { endAtTarget: target, endAtTzOffsetMin: tz() });
    assert.equal(s.timerMode, 'endAt');
    assert.equal(s.endAtTarget, target);
    assert.ok(Math.abs(s.durationMs - 10 * MIN) < 45000, `~10min, got ${s.durationMs}`);
    s = await c.send('startTimer', { timerMode: 'endAt', endAtTarget: target, endAtTzOffsetMin: tz() });
    assert.equal(s.mode, 'running');
    assert.ok(Math.abs(s.durationMs - 10 * MIN) < 45000);
    s = await c.send('resetTimer');
    assert.equal(s.mode, 'stopped');
    assert.equal(s.timerMode, 'endAt', 'Reset must not silently fall back to Duration');
    assert.equal(s.endAtTarget, target);
    assert.ok(Math.abs(s.durationMs - 10 * MIN) < 45000);
  } finally { c.socket.close(); }
});

test('the timezone of the SERVER never changes what HH:MM means (operator offset is honoured)', async () => {
  const { c } = await newControl();
  try {
    // Pretend the operator is 5h ahead of wherever the server is: a target whose
    // wall-clock time, in that offset, is ~30 minutes away must give ~30 minutes.
    const operatorOffset = tz() - 300; // Date#getTimezoneOffset is minus-east
    const d = new Date(Date.now() - operatorOffset * MIN + 30 * MIN + 20000);
    const target = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
    const s = await c.send('updateSettings', { endAtTarget: target, endAtTzOffsetMin: operatorOffset });
    assert.ok(Math.abs(s.durationMs - 30 * MIN) < 45000, `~30min, got ${s.durationMs / MIN}`);
  } finally { c.socket.close(); }
});

test('mode switch while stopped: each mode keeps its own value; typing a duration selects Duration', async () => {
  const { c } = await newControl();
  try {
    await c.send('updateSettings', { durationMs: 12 * MIN });
    const target = targetInMinutes(30);
    let s = await c.send('updateSettings', { endAtTarget: target, endAtTzOffsetMin: tz() });
    assert.equal(s.timerMode, 'endAt');
    assert.equal(s.configDurationMs, 12 * MIN);
    s = await c.send('updateSettings', { timerMode: 'duration' });
    assert.equal(s.durationMs, 12 * MIN); assert.equal(s.endAtTarget, target);
    s = await c.send('updateSettings', { timerMode: 'endAt' });
    assert.equal(s.timerMode, 'endAt');
    s = await c.send('updateSettings', { durationMs: 7 * MIN });
    assert.equal(s.timerMode, 'duration'); assert.equal(s.durationMs, 7 * MIN);
    s = await c.send('startTimer', { timerMode: 'duration', durationMs: 7 * MIN });
    assert.equal(s.durationMs, 7 * MIN);
  } finally { c.socket.close(); }
});

test('mode switch while running/paused never touches the live run', async () => {
  const { c } = await newControl();
  try {
    const target = targetInMinutes(30);
    await c.send('updateSettings', { endAtTarget: target, endAtTzOffsetMin: tz() });
    await c.send('updateSettings', { timerMode: 'duration', durationMs: 10 * MIN });
    let s = await c.send('startTimer', { timerMode: 'duration', durationMs: 10 * MIN });
    const startTime = s.startTime;
    s = await c.send('updateSettings', { timerMode: 'endAt' });
    assert.equal(s.mode, 'running'); assert.equal(s.durationMs, 10 * MIN); assert.equal(s.startTime, startTime);
    s = await c.send('pauseTimer');
    s = await c.send('updateSettings', { timerMode: 'duration' });
    assert.equal(s.mode, 'paused'); assert.equal(s.durationMs, 10 * MIN);
    s = await c.send('updateSettings', { timerMode: 'endAt' });
    s = await c.send('resetTimer');
    assert.equal(s.mode, 'stopped'); assert.equal(s.timerMode, 'endAt');
    assert.ok(Math.abs(s.durationMs - 30 * MIN) < 45000, 'Reset applies the switched mode');
  } finally { c.socket.close(); }
});

test('nudge while stopped in End at becomes Duration; rundown Take selects Duration and clears the target', async () => {
  const { c } = await newControl();
  try {
    await c.send('setRundown', [{ name: 'A', durationMs: 5 * MIN }, { name: 'B', durationMs: 10 * MIN }]);
    let s = await c.send('updateSettings', { endAtTarget: targetInMinutes(30), endAtTzOffsetMin: tz() });
    s = await c.send('nudgeTimer', MIN);
    assert.equal(s.timerMode, 'duration');
    assert.ok(Math.abs(s.durationMs - 31 * MIN) < 45000);
    await c.send('updateSettings', { endAtTarget: targetInMinutes(30), endAtTzOffsetMin: tz() });
    s = await c.send('goToRundown', { index: 1, autoStart: false });
    assert.equal(s.timerMode, 'duration'); assert.equal(s.endAtTarget, null);
    assert.equal(s.durationMs, 10 * MIN); assert.equal(s.rundownIndex, 1);
    s = await c.send('startTimer', { timerMode: 'duration', durationMs: 10 * MIN });
    assert.equal(s.durationMs, 10 * MIN);
  } finally { c.socket.close(); }
});

test('reconnect resync: a fresh controller receives mode, target and config; stopped End-at is refreshed', async () => {
  const { room, c } = await newControl();
  const target = targetInMinutes(15);
  await c.send('updateSettings', { durationMs: 9 * MIN });
  await c.send('updateSettings', { endAtTarget: target, endAtTzOffsetMin: tz() });
  c.socket.close();
  const c2 = connectControl(room.controlToken);
  try {
    const s = await c2.ready;
    assert.equal(s.timerMode, 'endAt'); assert.equal(s.endAtTarget, target); assert.equal(s.configDurationMs, 9 * MIN);
    assert.ok(Math.abs(s.durationMs - 15 * MIN) < 45000);
  } finally { c2.socket.close(); }
});

test('persistence: mode fields are written to the DB and a legacy row is normalised on load', async () => {
  const { room, c } = await newControl();
  try {
    const target = targetInMinutes(20);
    await c.send('updateSettings', { durationMs: 11 * MIN });
    await c.send('updateSettings', { endAtTarget: target, endAtTzOffsetMin: tz() });
    await sleep(900); // scheduleSave debounce is 500ms
    const stored = [...db.loadAllRoomStates().values()].find((st) => st.endAtTarget === target);
    assert.ok(stored, 'state saved');
    assert.equal(stored.timerMode, 'endAt'); assert.equal(stored.configDurationMs, 11 * MIN);
  } finally { c.socket.close(); }
  const tm = require('../timerModes');
  const legacy = tm.normalizeState({ mode: 'stopped', durationMs: 14 * MIN, endAtTarget: null });
  assert.equal(legacy.configDurationMs, 14 * MIN);
});

test('Companion REST parity: start/reset/nudge/set-duration follow the same mode model', async () => {
  const { room, c } = await newControl();
  try {
    const target = targetInMinutes(20);
    await c.send('updateSettings', { endAtTarget: target, endAtTzOffsetMin: tz() });
    let r = await rest(room, 'POST', 'start');
    assert.ok(r.ok);
    assert.equal(r.state.mode, 'running');
    assert.ok(Math.abs(r.state.durationMs - 20 * MIN) < 45000, 'REST Start on an End-at room runs time-to-target');
    r = await rest(room, 'POST', 'reset');
    assert.equal(r.state.mode, 'stopped'); assert.equal(r.state.timerMode, 'endAt');
    r = await rest(room, 'POST', 'set-duration', { durationMs: 6 * MIN });
    assert.equal(r.state.timerMode, 'duration'); assert.equal(r.state.durationMs, 6 * MIN);
    r = await rest(room, 'POST', 'nudge', { ms: MIN });
    assert.equal(r.state.durationMs, 7 * MIN);
    r = await rest(room, 'POST', 'start');
    assert.equal(r.state.durationMs, 7 * MIN);
    const g = await rest(room, 'GET', 'companion');
    assert.ok(g.ok && g.mode === 'running');
  } finally { c.socket.close(); }
});

test('setRundown: a plain array behaves exactly as before; { items, resetIndex } clears the current item (Replace)', async () => {
  const { c } = await newControl();
  try {
    const items = [{ name: 'A', durationMs: 5 * MIN }, { name: 'B', durationMs: 6 * MIN }, { name: 'C', durationMs: 7 * MIN }];
    let s = await c.send('setRundown', items);
    assert.equal(s.rundown.length, 3);
    s = await c.send('goToRundown', { index: 2, autoStart: false });
    assert.equal(s.rundownIndex, 2);
    // legacy shape: same index kept while still in range (unchanged behaviour)
    s = await c.send('setRundown', [items[2], items[1], items[0]]);
    assert.equal(s.rundownIndex, 2);
    assert.deepEqual(s.rundown.map((r) => r.name), ['C', 'B', 'A']);
    // legacy shape: index clamped when the list shrinks
    s = await c.send('setRundown', [items[0]]);
    assert.equal(s.rundownIndex, 0);
    // Replace shape: pointer cleared, order exactly as sent, timer untouched
    s = await c.send('startTimer', { timerMode: 'duration', durationMs: 5 * MIN });
    const startTime = s.startTime;
    s = await c.send('setRundown', { items: [items[1], items[2], items[0]], resetIndex: true });
    assert.equal(s.rundownIndex, -1);
    assert.deepEqual(s.rundown.map((r) => r.name), ['B', 'C', 'A']);
    assert.equal(s.mode, 'running'); assert.equal(s.startTime, startTime);
    // garbage payloads are ignored, rundown intact
    s = await c.send('setRundown', [{ name: 'Z', durationMs: MIN }]);
    c.socket.emit('setRundown', { items: 'nope' });
    c.socket.emit('setRundown', null);
    await sleep(150);
    assert.deepEqual(c.state.rundown.map((r) => r.name), ['Z']);
  } finally { c.socket.close(); }
});

test('End-at pause/resume over the wire: finish stays on the target (socket + REST); Duration keeps shift-on-pause', async () => {
  const { room, c } = await newControl();
  try {
    const target = targetInMinutes(20);
    await c.send('updateSettings', { endAtTarget: target, endAtTzOffsetMin: tz() });
    let s = await c.send('startTimer', { timerMode: 'endAt', endAtTarget: target, endAtTzOffsetMin: tz() });
    const finish0 = s.startTime + s.accumulatedPauseMs + s.durationMs;
    assert.equal(s.runEndAtMs, finish0);
    await c.send('pauseTimer');
    await sleep(600);
    s = await c.send('resumeTimer');
    assert.equal(s.startTime + s.accumulatedPauseMs + s.durationMs, finish0, 'socket resume keeps the absolute finish');
    let r = await rest(room, 'POST', 'pause');
    await sleep(600);
    r = await rest(room, 'POST', 'resume');
    assert.equal(r.state.startTime + r.state.accumulatedPauseMs + r.state.durationMs, finish0, 'REST resume keeps the absolute finish');
    // Duration run in the same room: pause shifts the finish
    await c.send('resetTimer');
    s = await c.send('updateSettings', { durationMs: 10 * MIN });
    s = await c.send('startTimer', { timerMode: 'duration', durationMs: 10 * MIN });
    assert.equal(s.runEndAtMs, null);
    await c.send('pauseTimer');
    await sleep(600);
    s = await c.send('resumeTimer');
    assert.ok(s.accumulatedPauseMs >= 500, 'Duration pause accumulated: ' + s.accumulatedPauseMs);
  } finally { c.socket.close(); }
});

test('applyEndAt over the wire: stopped commits; live re-targets atomically and every client (display) sees it; invalid is ignored', async () => {
  const { room, c } = await newControl();
  const disp = connectControl(room.displayToken); // display-role socket: receives the same authoritative broadcasts
  try {
    await disp.ready;
    const target1 = targetInMinutes(20);
    let s = await c.send('applyEndAt', { endAtTarget: target1, endAtTzOffsetMin: tz() });
    assert.equal(s.mode, 'stopped'); assert.equal(s.timerMode, 'endAt'); assert.equal(s.endAtTarget, target1);
    // invalid/incomplete: no broadcast, nothing changes
    let broadcasts = 0; c.socket.on('timerState', () => { broadcasts += 1; });
    c.socket.emit('applyEndAt', { endAtTarget: '' });
    c.socket.emit('applyEndAt', { endAtTarget: '9:' });
    c.socket.emit('applyEndAt', null);
    await sleep(200);
    assert.equal(broadcasts, 0, 'invalid applyEndAt produced no state change');
    // live retarget
    await c.send('startTimer', { timerMode: 'endAt' });
    const target2 = targetInMinutes(45);
    const seen = new Promise((resolve) => { const h = (st) => { if (st.endAtTarget === target2) { disp.socket.off('timerState', h); resolve(st); } }; disp.socket.on('timerState', h); });
    s = await c.send('applyEndAt', { endAtTarget: target2, endAtTzOffsetMin: tz() });
    const dispState = await seen;
    for (const st of [s, dispState]) {
      assert.equal(st.mode, 'running'); assert.equal(st.endAtTarget, target2);
      assert.equal(st.startTime + st.accumulatedPauseMs + st.durationMs, st.runEndAtMs);
      assert.ok(Math.abs(st.runEndAtMs - Date.now() - 45 * MIN) < 45000);
    }
    assert.equal(dispState.runEndAtMs, s.runEndAtMs, 'display got the same authoritative state');
    // pause + fixed-target resume still holds after a retarget
    await c.send('pauseTimer'); await sleep(400);
    s = await c.send('resumeTimer');
    assert.equal(s.startTime + s.accumulatedPauseMs + s.durationMs, s.runEndAtMs);
  } finally { c.socket.close(); disp.socket.close(); }
});

test('applyEndAt from an observer (non-active controller) is rejected and changes nothing', async () => {
  const { room, c } = await newControl();
  const obs = connectControl(room.controlToken);
  try {
    await obs.ready;
    await sleep(100);
    const rejected = new Promise((resolve) => obs.socket.once('controlRejected', resolve));
    const before = JSON.stringify((await rest(room, 'GET', 'state')).state);
    obs.socket.emit('applyEndAt', { endAtTarget: targetInMinutes(10), endAtTzOffsetMin: tz() });
    await rejected;
    assert.equal(JSON.stringify((await rest(room, 'GET', 'state')).state), before);
  } finally { c.socket.close(); obs.socket.close(); }
});

// ack helper: emit and resolve with the server's acknowledgement (and fail if none arrives)
function emitAck(c, event, payload, ms = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no ack for ${event}`)), ms);
    c.socket.emit(event, payload, (res) => { clearTimeout(t); resolve(res); });
  });
}

test('STOPPED: applyEndAt on a fresh Duration room configures End at (no Duration timer needed first); Start runs to that applied target', async () => {
  const { room, c } = await newControl();
  const disp = connectControl(room.displayToken);
  try {
    assert.equal(c.state.timerMode, 'duration');
    const target = targetInMinutes(20);
    const seen = waitForState(c, (s) => s.endAtTarget === target);
    const ack = await emitAck(c, 'applyEndAt', { endAtTarget: target, endAtTzOffsetMin: tz() });
    assert.deepEqual(ack, { ok: true });
    let s = await seen;
    assert.equal(s.mode, 'stopped');
    assert.equal(s.timerMode, 'endAt', 'mode switched to End at');
    assert.ok(Math.abs(s.durationMs - 20 * MIN) < 45000, `preview ~20:00, got ${s.durationMs}`);
    assert.equal(s.runEndAtMs == null, true, 'nothing started');
    // Start with NO target in the payload: uses the previously applied one
    s = await c.send('startTimer', { timerMode: 'endAt' });
    assert.equal(s.mode, 'running');
    assert.equal(s.endAtTarget, target);
    assert.ok(Math.abs(s.runEndAtMs - Date.now() - 20 * MIN) < 45000, 'runs toward the applied absolute target');
    assert.equal(s.startTime + s.accumulatedPauseMs + s.durationMs, s.runEndAtMs);
  } finally { c.socket.close(); disp.socket.close(); }
});

test('typing-equivalent traffic never mutates: a room with no applyEndAt keeps its state; Start without an applied target stays Duration', async () => {
  const { c } = await newControl();
  try {
    const before = JSON.stringify((({ timerMode, endAtTarget, durationMs, mode }) => ({ timerMode, endAtTarget, durationMs, mode }))(c.state));
    await sleep(300);
    assert.equal(JSON.stringify((({ timerMode, endAtTarget, durationMs, mode }) => ({ timerMode, endAtTarget, durationMs, mode }))(c.state)), before);
    const s = await c.send('startTimer', { timerMode: 'endAt' }); // no applied target: cannot be End at
    assert.equal(s.timerMode, 'duration'); assert.equal(s.runEndAtMs, null);
  } finally { c.socket.close(); }
});

test('LIVE confirm path: one applyEndAt retargets the running timer, is acknowledged, and control + display get the SAME state', async () => {
  const { room, c } = await newControl();
  const disp = connectControl(room.displayToken);
  try {
    await disp.ready;
    await c.send('updateSettings', { durationMs: 30 * MIN });
    let s = await c.send('startTimer', { timerMode: 'duration', durationMs: 30 * MIN });
    assert.equal(s.runEndAtMs, null);
    const target = targetInMinutes(50);
    const dSeen = waitForState(disp, (x) => x.endAtTarget === target);
    const cSeen = waitForState(c, (x) => x.endAtTarget === target);
    const ack = await emitAck(c, 'applyEndAt', { endAtTarget: target, endAtTzOffsetMin: tz() });
    assert.deepEqual(ack, { ok: true });
    const [cs, ds] = await Promise.all([cSeen, dSeen]);
    for (const st of [cs, ds]) {
      assert.equal(st.mode, 'running'); assert.equal(st.timerMode, 'endAt');
      assert.ok(Math.abs(st.runEndAtMs - Date.now() - 50 * MIN) < 45000);
      assert.equal(st.startTime + st.accumulatedPauseMs + st.durationMs, st.runEndAtMs);
    }
    for (const k of ['runEndAtMs', 'durationMs', 'startTime', 'accumulatedPauseMs', 'endAtTarget', 'mode']) assert.equal(cs[k], ds[k], k);
  } finally { c.socket.close(); disp.socket.close(); }
});

test('LIVE cancel: nothing is sent, nothing changes (the page only calls applyEndAt after the confirmation)', async () => {
  const { room, c } = await newControl();
  try {
    await c.send('startTimer', { timerMode: 'duration', durationMs: 10 * MIN });
    const before = JSON.stringify((await rest(room, 'GET', 'state')).state);
    await sleep(300); // (Cancel == no event at all)
    assert.equal(JSON.stringify((await rest(room, 'GET', 'state')).state), before);
  } finally { c.socket.close(); }
});

test('PAUSED confirm: retargets, stays paused, frozen display = target - now, Resume keeps the fixed target', async () => {
  const { c } = await newControl();
  try {
    await c.send('startTimer', { timerMode: 'duration', durationMs: 30 * MIN });
    await c.send('pauseTimer');
    const target = targetInMinutes(40);
    const ack = await emitAck(c, 'applyEndAt', { endAtTarget: target, endAtTzOffsetMin: tz() });
    assert.deepEqual(ack, { ok: true });
    await sleep(150);
    let s = c.state;
    assert.equal(s.mode, 'paused'); assert.equal(s.endAtTarget, target);
    const frozenRemaining = s.durationMs - (s.pauseTime - s.startTime - s.accumulatedPauseMs) * s.speed;
    assert.ok(Math.abs(frozenRemaining - 40 * MIN) < 45000, `frozen remaining ~40:00, got ${frozenRemaining}`);
    await sleep(400);
    s = await c.send('resumeTimer');
    assert.equal(s.startTime + s.accumulatedPauseMs + s.durationMs, s.runEndAtMs);
  } finally { c.socket.close(); }
});

test('failure is acknowledged, not silent: invalid => {ok:false,invalid}; observer => {ok:false,observer}; state unchanged', async () => {
  const { room, c } = await newControl();
  const obs = connectControl(room.controlToken);
  try {
    await obs.ready; await sleep(100);
    const before = JSON.stringify((await rest(room, 'GET', 'state')).state);
    assert.deepEqual(await emitAck(c, 'applyEndAt', { endAtTarget: '9:' }), { ok: false, reason: 'invalid' });
    assert.deepEqual(await emitAck(c, 'applyEndAt', {}), { ok: false, reason: 'invalid' });
    assert.deepEqual(await emitAck(obs, 'applyEndAt', { endAtTarget: targetInMinutes(10), endAtTzOffsetMin: tz() }), { ok: false, reason: 'observer' });
    assert.equal(JSON.stringify((await rest(room, 'GET', 'state')).state), before);
    // and a legacy caller with no ack callback still works
    c.socket.emit('applyEndAt', { endAtTarget: targetInMinutes(15), endAtTzOffsetMin: tz() });
    await sleep(200);
    assert.equal(c.state.timerMode, 'endAt');
  } finally { c.socket.close(); obs.socket.close(); }
});

// -- helpers for the tests above
function waitForState(c, predicate, ms = 3000) {
  return new Promise((resolve, reject) => {
    if (c.state && predicate(c.state)) return resolve(c.state);
    const t = setTimeout(() => { c.socket.off('timerState', h); reject(new Error('timed out waiting for matching state')); }, ms);
    const h = (st) => { if (predicate(st)) { clearTimeout(t); c.socket.off('timerState', h); resolve(st); } };
    c.socket.on('timerState', h);
  });
}

test('Add-in-middle (insertionIndex) persists correctly through setRundown, and existing reorder/remove still work afterward', async () => {
  const { room, c } = await newControl();
  try {
    const RundownText = require('../public/rundownText');
    const items = ['A', 'B', 'C', 'D', 'E'].map((name) => ({ name, durationMs: 5 * MIN }));
    let s = await c.send('setRundown', items);
    assert.deepEqual(s.rundown.map((r) => r.name), ['A', 'B', 'C', 'D', 'E']);

    // Simulate the control page: "C" (index 2) is the active/selected line, Add is pressed.
    const activeIndex = 2;
    const insertAt = RundownText.insertionIndex(activeIndex, s.rundown.length);
    assert.equal(insertAt, 3);
    const withInsert = s.rundown.map((r) => ({ name: r.name, durationMs: r.durationMs }));
    withInsert.splice(insertAt, 0, { name: '', durationMs: RundownText.DEFAULT_MS });
    s = await c.send('setRundown', withInsert);
    assert.deepEqual(s.rundown.map((r) => r.name), ['A', 'B', 'C', '', 'D', 'E'], 'new line landed immediately below the active one; later lines moved down');
    assert.equal(s.rundown[3].durationMs, RundownText.DEFAULT_MS);

    // Ordering persists - not just an echo of what we sent: read it back over a
    // completely separate channel (REST, as Companion/dashboard would).
    const read = (await rest(room, 'GET', 'state')).state;
    assert.deepEqual(read.rundown.map((r) => r.name), ['A', 'B', 'C', '', 'D', 'E']);

    // Existing reorder (drag-equivalent: resend the full array in a new order) still works.
    const named = (n) => read.rundown.find((r) => r.name === n);
    s = await c.send('setRundown', [named('D'), named('A'), named('C'), named(''), named('B'), named('E')]);
    assert.deepEqual(s.rundown.map((r) => r.name), ['D', 'A', 'C', '', 'B', 'E']);

    // Existing remove still works too.
    s = await c.send('setRundown', s.rundown.filter((r) => r.name !== ''));
    assert.deepEqual(s.rundown.map((r) => r.name), ['D', 'A', 'C', 'B', 'E']);
  } finally { c.socket.close(); }
});

// -----------------------------------------------------------------------------
// "Reset/Start commit whatever is staged first" - the control page fires the
// commit (applyEndAt / updateSettings) and the follow-up command (resetTimer /
// startTimer) back to back over ONE socket, without waiting for the commit's own
// acknowledgement. These tests prove the server processes same-socket events in
// the order they were sent (Socket.IO's own ordering guarantee), which is the
// load-bearing assumption behind that client-side pattern - not just plausible,
// verified against the real server.
// -----------------------------------------------------------------------------

// Two events fired back to back on the SAME socket, without waiting for the
// first's ack, must be processed by the server IN ORDER - collects each of the
// resulting broadcasts separately (the shared send() helper above only ever has
// one waiter pending at a time in the rest of this file, so it isn't suited to
// capturing two in flight at once).
function nextStates(c, n) {
  return new Promise((resolve) => {
    const collected = [];
    const handler = (s) => {
      collected.push(s);
      if (collected.length === n) { c.socket.off('timerState', handler); resolve(collected); }
    };
    c.socket.on('timerState', handler);
  });
}

test('ordering: applyEndAt immediately followed by startTimer (no endAtTarget in the startTimer payload) uses the just-applied target', async () => {
  const { c } = await newControl();
  try {
    const target = targetInMinutes(25);
    const states = nextStates(c, 2);
    c.socket.emit('applyEndAt', { endAtTarget: target, endAtTzOffsetMin: tz() });
    c.socket.emit('startTimer', { timerMode: 'endAt' }); // exactly what startTimer() now sends - no endAtTarget
    const [afterApply, afterStart] = await states;
    assert.equal(afterApply.mode, 'stopped'); assert.equal(afterApply.endAtTarget, target);
    assert.equal(afterStart.mode, 'running');
    assert.equal(afterStart.endAtTarget, target, 'Start used the target committed a moment earlier, not a stale one');
    assert.ok(Math.abs(afterStart.runEndAtMs - Date.now() - 25 * MIN) < 45000);
  } finally { c.socket.close(); }
});

test('Reset commits a staged Duration change made while RUNNING, then resets to it (commitStagedConfig)', async () => {
  const { c } = await newControl();
  try {
    await c.send('updateSettings', { durationMs: 10 * MIN });
    await c.send('startTimer', { timerMode: 'duration', durationMs: 10 * MIN });
    // Simulate: operator stages 20:00 in the box (never presses Set - Set is
    // disabled while running), then presses Reset. resetTimer() now fires the
    // commit and the reset back to back.
    const states = nextStates(c, 2);
    c.socket.emit('updateSettings', { timerMode: 'duration', durationMs: 20 * MIN });
    c.socket.emit('resetTimer');
    const [, afterReset] = await states;
    assert.equal(afterReset.mode, 'stopped');
    assert.equal(afterReset.timerMode, 'duration');
    assert.equal(afterReset.durationMs, 20 * MIN, 'Reset used the staged value, not the original 10:00');
  } finally { c.socket.close(); }
});

test('Reset commits a staged End-At target made while PAUSED, then resets into End-At mode', async () => {
  const { c } = await newControl();
  try {
    await c.send('startTimer', { timerMode: 'duration', durationMs: 10 * MIN });
    await c.send('pauseTimer');
    const target = targetInMinutes(30);
    const states = nextStates(c, 2);
    c.socket.emit('applyEndAt', { endAtTarget: target, endAtTzOffsetMin: tz() });
    c.socket.emit('resetTimer');
    const [, afterReset] = await states;
    assert.equal(afterReset.mode, 'stopped');
    assert.equal(afterReset.timerMode, 'endAt');
    assert.equal(afterReset.endAtTarget, target);
    assert.ok(Math.abs(afterReset.durationMs - 30 * MIN) < 45000, 'stopped preview is time-to-target');
  } finally { c.socket.close(); }
});

test('Reset with nothing staged is unaffected (the common case: no extra commit, behaves exactly as before)', async () => {
  const { c } = await newControl();
  try {
    await c.send('updateSettings', { durationMs: 12 * MIN });
    await c.send('startTimer', { timerMode: 'duration', durationMs: 12 * MIN });
    await c.send('nudgeTimer', 3 * MIN); // live-only change, never "staged" client-side
    const s = await c.send('resetTimer');
    assert.equal(s.mode, 'stopped');
    assert.equal(s.durationMs, 12 * MIN, 'reset to the configured duration, the nudge is not treated as a pending commit');
  } finally { c.socket.close(); }
});

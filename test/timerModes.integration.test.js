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
  return { slug, controlToken: new URL(body.controlUrl).searchParams.get('token') };
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
  process.exit(0); // server.js's 1 Hz interval is not unref'd (see bridgeStatus test)
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

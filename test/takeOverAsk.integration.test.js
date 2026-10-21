'use strict';

// Integration: "Ask before handing over" (the room's takeOverAsk setting).
// Take over asks the panel in control; Allow / Refuse / no answer / the panel
// in control leaving / the asker cancelling. Same in-process server + real
// socket.io harness as the other integration tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { io: ioClient } = require('socket.io-client');

const PORT = 3952;
const BASE_URL = `http://127.0.0.1:${PORT}`;

process.env.DATABASE_PATH = path.join(os.tmpdir(), `pt-ask-test-${Date.now()}-${process.pid}.sqlite`);
process.env.PORT = String(PORT);
process.env.LEGACY_ROOMS_JSON_PATH = path.join(os.tmpdir(), `pt-ask-test-no-such-file-${Date.now()}.json`);
process.env.TAKE_OVER_ASK_MS = '600'; // "no answer" comes quickly in tests

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
const once = (s, ev) => new Promise((resolve) => s.once(ev, resolve));
const sockets = [];
let key;

// A control panel that keeps track of who is in control.
async function panel(token, name) {
  const s = ioClient(BASE_URL, { auth: { token, deviceName: name, panelId: `p-${name}`, deviceId: `d-${name}` }, transports: ['websocket'], reconnection: false, forceNew: true });
  sockets.push(s);
  s.controller = null;
  s.on('controllerStatus', (st) => { s.controller = st.activeControllerSocketId; });
  await once(s, 'timerState');
  await sleep(100);
  return s;
}
const inControl = (s) => s.controller === s.id;

async function roomWithAsk(slug) {
  const res = await fetch(`${BASE_URL}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ slug }) });
  const room = await res.json();
  const token = tokenOf(room.controlUrl);
  const a = await panel(token, 'A');
  assert.ok(inControl(a), 'the first panel is in control');
  a.emit('updateSettings', { takeOverAsk: true });
  await sleep(100);
  const b = await panel(token, 'B');
  assert.ok(!inControl(b));
  return { a, b };
}

test.before(async () => {
  for (let i = 0; i < 20; i++) { try { await fetch(`${BASE_URL}/`); break; } catch { await sleep(100); } }
  key = db.createClient('Ask Client').apiKey;
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

test('Allow hands control over; Refuse keeps it', async () => {
  const { a, b } = await roomWithAsk('Allow room');
  let asked = once(a, 'takeOverRequest');
  const asking = once(b, 'takeOverAsking');
  b.emit('requestControl');
  const req = await asked;
  assert.equal(req.requesterName, 'B');
  assert.equal((await asking).holderName, 'A');
  assert.ok(inControl(a), 'nothing changes while asking');

  let result = once(b, 'takeOverResult');
  a.emit('takeOverAnswer', { id: req.id, allow: false });
  assert.equal((await result).result, 'refused');
  await sleep(100);
  assert.ok(inControl(a));

  asked = once(a, 'takeOverRequest');
  b.emit('requestControl');
  const req2 = await asked;
  result = once(b, 'takeOverResult');
  a.emit('takeOverAnswer', { id: req2.id, allow: true });
  assert.equal((await result).result, 'allowed');
  await sleep(100);
  assert.ok(inControl(b));
});

test('no answer hands over; so does the panel in control leaving', async () => {
  const { a, b } = await roomWithAsk('Timeout room');
  const ended = once(a, 'takeOverRequestEnded');
  b.emit('requestControl');
  assert.equal((await ended).result, 'timeout');
  await sleep(100);
  assert.ok(inControl(b), 'no answer: control passes');

  // now B is in control (the setting is still on); A asks, then B disappears
  const asked = once(b, 'takeOverRequest');
  a.emit('requestControl');
  await asked;
  const result = once(a, 'takeOverResult');
  b.close();
  assert.equal((await result).result, 'holderLeft');
  await sleep(100);
  assert.ok(inControl(a));
});

test('the asker can cancel, and without the setting Take over is instant', async () => {
  const { a, b } = await roomWithAsk('Cancel room');
  const asked = once(a, 'takeOverRequest');
  b.emit('requestControl');
  await asked;
  const ended = once(a, 'takeOverRequestEnded');
  b.emit('takeOverCancel');
  assert.equal((await ended).result, 'cancelled');
  assert.ok(inControl(a));

  a.emit('updateSettings', { takeOverAsk: false });
  await sleep(100);
  b.emit('requestControl');
  await sleep(150);
  assert.ok(inControl(b), 'instant when the setting is off');
});

test('Companion sees who is in control and a waiting request, and can answer it', async () => {
  const { a, b } = await roomWithAsk('Companion room');
  const rest = (method, p, body) => fetch(`${BASE_URL}/api/rooms/${encodeURIComponent('Companion room')}${p}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());

  let c = await rest('GET', '/companion');
  assert.equal(c.controller, 'A');
  assert.equal(c.takeOverRequest, null);

  const asked = once(a, 'takeOverRequest');
  b.emit('requestControl');
  await asked;
  c = await rest('GET', '/companion');
  assert.equal(c.takeOverRequest.requesterName, 'B');
  assert.ok(c.takeOverRequest.secondsLeft >= 0);

  const result = once(b, 'takeOverResult');
  const ended = once(a, 'takeOverRequestEnded');
  assert.ok((await rest('POST', '/takeover', { allow: false })).ok);
  assert.equal((await result).result, 'refused');
  assert.equal((await ended).result, 'refused', 'the asked panel closes its Allow / Refuse');
  assert.equal((await rest('POST', '/takeover', { allow: true })).ok, false, 'nothing left to answer');
  assert.ok(inControl(a));
});

test('a Companion duration preset never changes a running timer', async () => {
  const { a } = await roomWithAsk('Preset room');
  const rest = (method, p, body) => fetch(`${BASE_URL}/api/rooms/${encodeURIComponent('Preset room')}${p}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());
  await rest('POST', '/set-duration', { durationMs: 20 * 60000 });
  assert.equal((await rest('GET', '/companion')).configDurationMs, 20 * 60000);
  await rest('POST', '/start');
  await rest('POST', '/set-duration', { durationMs: 30 * 60000 });
  const c = await rest('GET', '/companion');
  assert.equal(c.configDurationMs, 30 * 60000, 'the setting changes');
  assert.ok(c.remainingMs <= 20 * 60000 && c.remainingMs > 19 * 60000, 'the run keeps its 20 minutes');
  await rest('POST', '/reset');
  assert.equal((await rest('GET', '/companion')).remainingMs, 30 * 60000, 'Reset goes to the new setting');
  a.close();
});

test('Start at: armed from a control page or Companion; starting by hand cancels it', async () => {
  const { a } = await roomWithAsk('Schedule room');
  const rest = (method, p, body) => fetch(`${BASE_URL}/api/rooms/${encodeURIComponent('Schedule room')}${p}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());
  const inAnHour = new Date(Date.now() + 3600 * 1000);
  const hhmm = `${String(inAnHour.getHours()).padStart(2, '0')}:${String(inAnHour.getMinutes()).padStart(2, '0')}`;

  const armed = await new Promise((resolve) => a.emit('armStart', { startAt: hhmm, tzOffsetMin: new Date().getTimezoneOffset() }, resolve));
  assert.equal(armed.ok, true);
  let c = await rest('GET', '/companion');
  assert.equal(c.scheduledStartLabel, hhmm);
  assert.ok(c.scheduledStartAt > Date.now() + 58 * 60000 && c.scheduledStartAt <= Date.now() + 3600 * 1000);
  assert.equal(c.mode, 'stopped');

  // a person pressing Start wins: the schedule is cancelled, with a note
  const state = new Promise((resolve) => a.on('timerState', (s) => { if (s.mode === 'running') resolve(s); }));
  a.emit('startTimer', {});
  const s = await state;
  assert.equal(s.scheduledStartAt, null);
  assert.match(s.scheduleNote.text, /cancelled/);
  await rest('POST', '/reset');

  // Companion arms and cancels
  assert.ok((await rest('POST', '/schedule', { startAt: hhmm })).scheduledStartAt);
  assert.equal((await rest('GET', '/companion')).scheduledStartLabel, hhmm);
  assert.equal((await rest('POST', '/schedule', { startAt: null })).scheduledStartAt, null);
  assert.equal((await rest('POST', '/schedule', { startAt: '99:99' })).ok, false);
  a.close();
});

test('running order: one selection for the room; Take moves it on', async () => {
  const { a } = await roomWithAsk('Selection room');
  const rest = (method, p, body) => fetch(`${BASE_URL}/api/rooms/${encodeURIComponent('Selection room')}${p}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());
  a.emit('setRundown', { items: [{ name: 'One', durationMs: 60000 }, { name: 'Two', durationMs: 60000 }, { name: 'Three', durationMs: 60000 }], resetIndex: true });
  await sleep(150);
  assert.equal((await rest('POST', '/rundown/select', { step: 1 })).rundownSelected, 0, 'nothing selected yet: Next picks the first');
  assert.equal((await rest('POST', '/rundown/select', { step: 1 })).rundownSelected, 1);
  const seen = new Promise((resolve) => a.on('timerState', (s) => { if (s.rundownSelected === 2) resolve(s); }));
  await rest('POST', '/rundown/select', { index: 2 });
  assert.equal((await seen).rundownSelected, 2, 'a control page sees Companion\'s selection');
  a.emit('selectRundown', { index: 0 });
  await sleep(150);
  assert.equal((await rest('GET', '/companion')).rundownSelected, 0, 'and Companion sees the page\'s');
  await rest('POST', '/rundown/goto', { index: 0 });
  const c = await rest('GET', '/companion');
  assert.equal(c.rundownIndex, 0);
  assert.equal(c.rundownSelected, 1, 'after a Take the selection moves to the next item');
  assert.equal((await rest('POST', '/rundown/select', { index: 99 })).rundownSelected, 2, 'clamped to the last item');
  a.close();
});

'use strict';

// Integration: paired screens. A browser at /screen asks for a pairing code,
// someone pairs it from their dashboard with a name and a room, and the screen
// then follows every change: another room, New links, the room being deleted,
// or the screen being removed. Screens belong to one client only. Same
// in-process server + real socket.io harness as the other integration tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { io: ioClient } = require('socket.io-client');

const PORT = 3955;
const BASE_URL = `http://127.0.0.1:${PORT}`;

process.env.DATABASE_PATH = path.join(os.tmpdir(), `pt-screens-test-${Date.now()}-${process.pid}.sqlite`);
process.env.PORT = String(PORT);
process.env.LEGACY_ROOMS_JSON_PATH = path.join(os.tmpdir(), `pt-screens-test-no-such-file-${Date.now()}.json`);

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

let keyA, keyB;
const openSockets = []; // every screen socket, closed at the end even if the server closed it first
function screenSocket(token) {
  const socket = ioClient(BASE_URL, { auth: { screenToken: token }, transports: ['websocket'], reconnection: false, forceNew: true });
  openSockets.push(socket);
  return socket;
}
const api = (key, p, method = 'GET', body) => fetch(`${BASE_URL}${p}`, {
  method,
  headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, ...(await r.json()) }));

async function createRoom(key, slug) {
  const body = await api(key, '/api/rooms', 'POST', { slug });
  assert.ok(body.ok, JSON.stringify(body));
  return { id: body.roomId, slug, display: tokenOf(body.displayUrl) };
}

// A screen: its socket and the latest thing it was told to show.
async function openScreen() {
  const fresh = await api(null, '/api/screens/new', 'POST');
  assert.ok(fresh.ok && fresh.token && /^[A-Z2-9]{6}$/.test(fresh.code), JSON.stringify(fresh));
  assert.match(fresh.qrSvg, /<svg/);
  const socket = screenSocket(fresh.token);
  const screen = { socket, token: fresh.token, code: fresh.code, shown: null };
  socket.on('screenAssignment', (a) => { screen.shown = a; });
  await new Promise((resolve) => socket.once('screenAssignment', resolve));
  return screen;
}

test.before(async () => {
  for (let i = 0; i < 20; i++) { try { await fetch(`${BASE_URL}/`); break; } catch { await sleep(100); } }
  keyA = db.createClient('Screens Client A').apiKey;
  keyB = db.createClient('Screens Client B').apiKey;
});

test.after(async () => {
  openSockets.forEach((s) => s.close());
  await new Promise((resolve) => {
    if (!capturedServer) return resolve();
    if (typeof capturedServer.closeAllConnections === 'function') capturedServer.closeAllConnections();
    capturedServer.close(() => resolve());
  });
  console.log = realConsoleLog;
  // server.js's once-a-second timer tick keeps the process alive (as in the other suites)
  setTimeout(() => process.exit(0), 300);
});

test('a new screen shows a pairing code; a wrong code is refused; the right one (any case, with a dash) pairs it', async () => {
  const room = await createRoom(keyA, 'Main Hall');
  const screen = await openScreen();
  assert.deepEqual(screen.shown, { state: 'pending', code: screen.code });

  const wrong = await api(keyA, '/api/screens/pair', 'POST', { code: 'ZZZZZZ', name: 'x' });
  assert.equal(wrong.status, 404);

  const typed = `${screen.code.slice(0, 3).toLowerCase()}-${screen.code.slice(3)}`;
  const paired = await api(keyA, '/api/screens/pair', 'POST', { code: typed, name: '  Lectern bar ', roomId: room.id });
  assert.ok(paired.ok, JSON.stringify(paired));
  assert.equal(paired.screen.name, 'Lectern bar');
  await sleep(150);
  assert.equal(screen.shown.state, 'room');
  assert.equal(screen.shown.displayToken, room.display);
  assert.equal(screen.shown.roomName, 'Main Hall');

  // a code only pairs once
  assert.equal((await api(keyA, '/api/screens/pair', 'POST', { code: screen.code })).status, 404);

  const list = await api(keyA, '/api/screens');
  assert.equal(list.screens.length, 1);
  assert.equal(list.screens[0].online, true);
  assert.match(list.screenUrl, /\/screen$/);
  screen.socket.close();
  await sleep(150);
  assert.equal((await api(keyA, '/api/screens')).screens[0].online, false);
});

test('a paired screen follows: another room, New links, no room, the room deleted, being removed', async () => {
  const one = await createRoom(keyA, 'Room One');
  const two = await createRoom(keyA, 'Room Two');
  const screen = await openScreen();
  const { screen: paired } = await api(keyA, '/api/screens/pair', 'POST', { code: screen.code, name: 'Stage left', roomId: one.id });
  await sleep(150);
  assert.equal(screen.shown.displayToken, one.display);

  await api(keyA, `/api/screens/${paired.id}`, 'PATCH', { roomId: two.id });
  await sleep(150);
  assert.equal(screen.shown.displayToken, two.display);

  const fresh = await api(keyA, `/api/rooms/${encodeURIComponent('Room Two')}/regenerate-tokens`, 'POST');
  await sleep(150);
  assert.equal(screen.shown.displayToken, tokenOf(fresh.displayUrl), 'follows New links');

  await api(keyA, `/api/screens/${paired.id}`, 'PATCH', { roomId: null });
  await sleep(150);
  assert.equal(screen.shown.state, 'idle');
  assert.equal(screen.shown.name, 'Stage left');

  await api(keyA, `/api/screens/${paired.id}`, 'PATCH', { roomId: one.id, name: 'Stage right' });
  await api(keyA, `/api/rooms/${encodeURIComponent('Room One')}`, 'DELETE');
  await sleep(150);
  assert.equal(screen.shown.state, 'idle', 'its room was deleted');
  assert.equal(screen.shown.name, 'Stage right');

  await api(keyA, `/api/screens/${paired.id}`, 'DELETE');
  await sleep(150);
  assert.equal(screen.shown.state, 'unknown', 'removed: it asks for a new code');
  assert.equal(db.getScreenByToken(screen.token), null);
});

test('screens belong to one client: no pairing to another client\'s room, no seeing or changing their screens', async () => {
  const roomA = await createRoom(keyA, 'A Room');
  const roomB = await createRoom(keyB, 'B Room');
  const screen = await openScreen();
  assert.equal((await api(keyA, '/api/screens/pair', 'POST', { code: screen.code, roomId: roomB.id })).status, 400);
  const { screen: paired } = await api(keyA, '/api/screens/pair', 'POST', { code: screen.code, name: 'Mine', roomId: roomA.id });

  assert.ok(!(await api(keyB, '/api/screens')).screens.some((s) => s.id === paired.id));
  assert.equal((await api(keyB, `/api/screens/${paired.id}`, 'PATCH', { name: 'Stolen' })).status, 404);
  assert.equal((await api(keyB, `/api/screens/${paired.id}`, 'DELETE')).status, 404);
  assert.equal((await api(keyA, `/api/screens/${paired.id}`, 'PATCH', { roomId: roomB.id })).status, 400);
  assert.equal((await api(null, '/api/screens')).status, 401);
  screen.socket.close();
});

test('an unknown screen token is told so (the page then asks for a new code); pending screens expire', async () => {
  const socket = screenSocket('not-a-real-token');
  const shown = await new Promise((resolve) => socket.once('screenAssignment', resolve));
  assert.deepEqual(shown, { state: 'unknown' });
  socket.close();

  const old = db.createPendingScreen(Date.now() - db.SCREEN_PENDING_TTL_MS - 1000);
  assert.equal(db.getPendingScreenByCode(old.code), null, 'an expired code no longer pairs');
  assert.ok(db.deleteExpiredPendingScreens().includes(Number(old.id)));
});

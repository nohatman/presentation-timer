'use strict';

// Integration: the Foxy Timer Online side of "Share over the internet"
// (relayHub.js). A fake laptop connects to /relay the way relayAgent.js does;
// public phones connect with public links. Checks registration, publishing,
// passing messages both ways (incl. acknowledgements), the offline notice,
// refusals, background images and what a public display may see. Same
// in-process server + real socket.io harness as the other integration tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { io: ioClient } = require('socket.io-client');

const PORT = 3954;
const BASE_URL = `http://127.0.0.1:${PORT}`;

process.env.DATABASE_PATH = path.join(os.tmpdir(), `pt-relay-test-${Date.now()}-${process.pid}.sqlite`);
process.env.PORT = String(PORT);
process.env.LEGACY_ROOMS_JSON_PATH = path.join(os.tmpdir(), `pt-relay-test-no-such-file-${Date.now()}.json`);

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
const sockets = [];
const connect = (url, auth) => { const s = ioClient(url, { auth, transports: ['websocket'], reconnection: false, forceNew: true }); sockets.push(s); return s; };
const post = (p, body) => fetch(`${BASE_URL}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
  .then(async (r) => ({ status: r.status, ...(await r.json()) }));

// A fake laptop: registers, connects to /relay, publishes rooms.
async function laptop(rooms) {
  const reg = await post('/api/relay/register');
  assert.ok(reg.ok && reg.secret, JSON.stringify(reg));
  const socket = connect(`${BASE_URL}/relay`, { secret: reg.secret });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  const published = await new Promise((resolve) => socket.emit('publish', { rooms }, resolve));
  assert.ok(published.ok);
  return { socket, secret: reg.secret, links: published.links };
}

test.before(async () => {
  for (let i = 0; i < 20; i++) { try { await fetch(`${BASE_URL}/`); break; } catch { await sleep(100); } }
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

test('a laptop registers, publishes its rooms and gets public links that stay the same', async () => {
  const lap = await laptop([{ localId: '7', slug: 'Main Hall' }, { localId: '8', slug: 'Breakout' }]);
  assert.deepEqual(Object.keys(lap.links).sort(), ['7', '8']);
  assert.match(lap.links['7'].controlUrl, /\/control\?token=r/);
  // publishing again keeps the links; a room the laptop dropped loses its link
  const again = await new Promise((resolve) => lap.socket.emit('publish', { rooms: [{ localId: '7', slug: 'Main Hall (renamed)' }] }, resolve));
  assert.equal(again.links['7'].controlUrl, lap.links['7'].controlUrl);
  assert.equal(again.links['8'], undefined);
  assert.equal(db.getRelayRoomByToken(tokenOf(lap.links['8'].controlUrl)), null);

  const bad = connect(`${BASE_URL}/relay`, { secret: 'rs_not-a-real-secret' });
  const err = await new Promise((resolve) => bad.once('relayError', resolve));
  assert.match(err.message, /not registered/);
});

test('a public phone reaches the laptop and back, acknowledgements included', async () => {
  const lap = await laptop([{ localId: '1', slug: 'Main Hall' }]);
  const opened = new Promise((resolve) => lap.socket.once('panelOpen', resolve));
  const phone = connect(BASE_URL, { token: tokenOf(lap.links['1'].controlUrl), deviceName: 'Remote', panelId: 'p1', deviceId: 'd1' });
  const open = await opened;
  assert.equal(open.localId, '1');
  assert.equal(open.role, 'control');
  assert.deepEqual(open.auth, { deviceName: 'Remote', panelId: 'p1', deviceId: 'd1' });
  if (!phone.connected) await new Promise((resolve) => phone.once('connect', resolve));
  assert.equal(open.panelKey, phone.id, 'the panel key is the phone\'s own connection id');

  // laptop -> phone
  const got = new Promise((resolve) => phone.once('timerState', resolve));
  lap.socket.emit('panelEvent', { panelKey: open.panelKey, event: 'timerState', args: [{ mode: 'running' }] });
  assert.deepEqual(await got, { mode: 'running' });

  // phone -> laptop, with and without an acknowledgement
  const emitted = new Promise((resolve) => lap.socket.once('panelEmit', resolve));
  phone.emit('startTimer', { x: 1 });
  assert.deepEqual(await emitted, { panelKey: phone.id, event: 'startTimer', args: [{ x: 1 }] });
  lap.socket.once('panelEmit', (msg) => lap.socket.emit('panelAck', { panelKey: msg.panelKey, ackId: msg.ackId, args: [{ ok: true }] }));
  const ack = await new Promise((resolve) => phone.emit('applyEndAt', { endAt: '14:00' }, resolve));
  assert.deepEqual(ack, { ok: true });

  // a phone closing tells the laptop
  const closed = new Promise((resolve) => lap.socket.once('panelClose', resolve));
  phone.close();
  assert.deepEqual(await closed, { panelKey: open.panelKey });
});

test('the laptop going offline is told to waiting phones, and they reconnect through when it is back', async () => {
  const lap = await laptop([{ localId: '1', slug: 'Room' }]);
  const display = connect(BASE_URL, { token: tokenOf(lap.links['1'].displayUrl) });
  await new Promise((resolve) => display.once('relayNotice', resolve));
  const offline = new Promise((resolve) => display.on('relayNotice', (n) => { if (n.offline) resolve(n); }));
  lap.socket.close();
  assert.deepEqual(await offline, { offline: true });

  // back again: the waiting display is opened on the laptop straight away
  const back = connect(`${BASE_URL}/relay`, { secret: lap.secret });
  const reopened = new Promise((resolve) => back.once('panelOpen', resolve));
  await new Promise((resolve) => back.once('connect', resolve));
  back.emit('publish', { rooms: [{ localId: '1', slug: 'Room' }] }, () => {});
  const msg = await reopened;
  assert.equal(msg.role, 'display');
});

test('refusals, background images, and what a public display may see', async () => {
  const lap = await laptop([{ localId: '3', slug: 'Room' }]);
  // the laptop refuses a phone (e.g. room deleted)
  lap.socket.once('panelOpen', (msg) => lap.socket.emit('panelRefused', { panelKey: msg.panelKey, message: 'Gone.' }));
  const phone = connect(BASE_URL, { token: tokenOf(lap.links['3'].controlUrl) });
  assert.deepEqual(await new Promise((resolve) => phone.once('authError', resolve)), { message: 'Gone.' });

  // background image comes from the laptop
  lap.socket.on('backgroundGet', (msg) => lap.socket.emit('background', { requestId: msg.requestId, ok: true, mime: 'image/png', data: Buffer.from('PNGDATA').toString('base64') }));
  const res = await fetch(`${BASE_URL}/api/display-background?token=${tokenOf(lap.links['3'].displayUrl)}&v=1`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'PNGDATA');
  // ...but can't be changed through a public link
  const put = await fetch(`${BASE_URL}/api/display-background`, { method: 'PUT', headers: { 'X-Room-Token': tokenOf(lap.links['3'].controlUrl) }, body: 'x' });
  assert.equal(put.status, 409);

  // share links: a public control link gets the public links; a display link gets nothing
  const share = await post('/api/room-links', { token: tokenOf(lap.links['3'].controlUrl) });
  assert.ok(share.ok);
  assert.equal(share.displayUrl, lap.links['3'].displayUrl);
  assert.match(share.controlQr, /<svg/);
  assert.equal((await post('/api/room-links', { token: tokenOf(lap.links['3'].displayUrl) })).status, 403);
});

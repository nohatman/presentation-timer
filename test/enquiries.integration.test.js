'use strict';

// Integration: real server.js in-process. The landing-page contact form stores
// an enquiry, a Platform Admin can list it and mark it handled, a normal user
// cannot, spam is swallowed, and the per-IP rate limit kicks in.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');

const PORT = 3963;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const scratchDbPath = path.join(os.tmpdir(), `pt-enquiries-test-${Date.now()}-${process.pid}.sqlite`);
process.env.DATABASE_PATH = scratchDbPath;
process.env.PORT = String(PORT);
process.env.LEGACY_ROOMS_JSON_PATH = path.join(os.tmpdir(), `pt-enquiries-test-no-such-file-${Date.now()}.json`);
delete process.env.RESEND_API_KEY;

const realConsoleLog = console.log;
console.log = () => {};

const db = require('../db');

let capturedServer = null;
const originalCreateServer = http.createServer.bind(http);
http.createServer = (...args) => { capturedServer = originalCreateServer(...args); return capturedServer; };
require('../server');
http.createServer = originalCreateServer;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function post(pathname, body, cookie) {
  return fetch(`${BASE_URL}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body)
  });
}

async function login(email, password) {
  const res = await post('/api/auth/login', { email, password });
  assert.equal(res.status, 200);
  return res.headers.get('set-cookie').split(';')[0];
}

let adminCookie; let userCookie;

test.before(async () => {
  for (let i = 0; i < 50 && !(capturedServer && capturedServer.listening); i++) await sleep(50);
  const admin = db.createPlatformAdmin('Enq Admin Co');
  db.createUser('admin@enq.test', 'admin-pass-123', admin.id);
  const client = db.createClient('Enq Normal Co');
  db.createUser('user@enq.test', 'user-pass-123', client.id);
  adminCookie = await login('admin@enq.test', 'admin-pass-123');
  userCookie = await login('user@enq.test', 'user-pass-123');
});

test.after(() => {
  console.log = realConsoleLog;
  capturedServer.close();
  setTimeout(() => process.exit(0), 100).unref();
  try { fs.unlinkSync(scratchDbPath); } catch { /* ignore */ }
});

test('contact form: store, admin list, handled, spam, auth and rate limit', async () => {
  // 1: a valid enquiry is stored
  let res = await post('/api/contact', { name: 'Sam', email: 'Sam@Crew.co', company: 'Crew Ltd', interests: ['trial', 'local'], message: '6 breakouts' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  // 2: an invalid one is refused with a message
  res = await post('/api/contact', { name: '', email: 'x' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /name/);

  // 3: the honeypot looks like success but is not stored
  res = await post('/api/contact', { name: 'Bot', email: 'bot@spam.co', website: 'spam' });
  assert.equal(res.status, 200);

  await sleep(100); // email status is written after the reply
  const list = await (await fetch(`${BASE_URL}/api/admin/enquiries`, { headers: { Cookie: adminCookie } })).json();
  assert.equal(list.ok, true);
  assert.equal(list.enquiries.length, 1);
  const e = list.enquiries[0];
  assert.equal(e.email, 'sam@crew.co');
  assert.deepEqual(e.interests, ['trial', 'local']);
  assert.equal(e.email_status, 'not_configured');
  assert.equal(e.handled_at, null);

  // Non-admins and anonymous callers can't read or change enquiries
  assert.equal((await fetch(`${BASE_URL}/api/admin/enquiries`, { headers: { Cookie: userCookie } })).status, 403);
  assert.equal((await fetch(`${BASE_URL}/api/admin/enquiries`)).status, 401);
  assert.equal((await post(`/api/admin/enquiries/${e.id}/handled`, {}, userCookie)).status, 403);

  // Mark handled, then reopen
  let h = await (await post(`/api/admin/enquiries/${e.id}/handled`, { handled: true }, adminCookie)).json();
  assert.ok(h.enquiry.handled_at);
  h = await (await post(`/api/admin/enquiries/${e.id}/handled`, { handled: false }, adminCookie)).json();
  assert.equal(h.enquiry.handled_at, null);
  assert.equal((await post('/api/admin/enquiries/99999/handled', {}, adminCookie)).status, 404);

  // 4 and 5 are still allowed; a 6th within the hour is rate-limited
  assert.equal((await post('/api/contact', { name: 'A', email: 'a@b.co' })).status, 200);
  assert.equal((await post('/api/contact', { name: 'B', email: 'b@b.co' })).status, 200);
  assert.equal((await post('/api/contact', { name: 'C', email: 'c@b.co' })).status, 429);
});

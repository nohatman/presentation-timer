'use strict';

// Integration: real server.js in-process. Foxy Timer for Windows trial
// licences - admin settings (length + download link), the download redirect,
// a machine starting a trial and getting the same expiry back, a licence that
// verifies offline, and an admin extending a trial.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');

const PORT = 3968;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const scratchDbPath = path.join(os.tmpdir(), `pt-wintrials-test-${Date.now()}-${process.pid}.sqlite`);
process.env.DATABASE_PATH = scratchDbPath;
process.env.PORT = String(PORT);
process.env.LEGACY_ROOMS_JSON_PATH = path.join(os.tmpdir(), `pt-wintrials-test-no-such-file-${Date.now()}.json`);
delete process.env.WINDOWS_DOWNLOAD_URL;

// A throwaway key pair; the env var is single-line with literal \n like Railway's.
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const testPublicKey = publicKey.export({ type: 'spki', format: 'pem' });
process.env.FOXY_LICENCE_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).trim().replace(/\n/g, '\\n');

const realConsoleLog = console.log;
console.log = () => {};

const db = require('../db');
const trials = require('../trials');

let capturedServer = null;
const originalCreateServer = http.createServer.bind(http);
http.createServer = (...args) => { capturedServer = originalCreateServer(...args); return capturedServer; };
require('../server');
http.createServer = originalCreateServer;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 24 * 60 * 60 * 1000;
const MACHINE = 'ab'.repeat(32);

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
  const admin = db.createPlatformAdmin('Trial Admin Co');
  db.createUser('admin@trial.test', 'admin-pass-123', admin.id);
  const client = db.createClient('Trial Normal Co');
  db.createUser('user@trial.test', 'user-pass-123', client.id);
  adminCookie = await login('admin@trial.test', 'admin-pass-123');
  userCookie = await login('user@trial.test', 'user-pass-123');
});

test.after(() => {
  console.log = realConsoleLog;
  capturedServer.close();
  setTimeout(() => process.exit(0), 100).unref();
  try { fs.unlinkSync(scratchDbPath); } catch { /* ignore */ }
});

test('download link: hidden until set, then redirects', async () => {
  let info = await (await fetch(`${BASE_URL}/api/windows/info`)).json();
  assert.deepEqual(info, { ok: true, trialDays: 14, downloadAvailable: false });
  assert.equal((await fetch(`${BASE_URL}/download/windows`, { redirect: 'manual' })).status, 404);

  assert.equal((await post('/api/admin/windows-trials/settings', { downloadUrl: 'http://insecure.example/x.exe' }, adminCookie)).status, 400);
  assert.equal((await post('/api/admin/windows-trials/settings', { downloadUrl: 'https://example.com/FoxyTimerSetup.exe' }, userCookie)).status, 403);
  assert.equal((await post('/api/admin/windows-trials/settings', { downloadUrl: 'https://example.com/FoxyTimerSetup.exe' }, adminCookie)).status, 200);

  info = await (await fetch(`${BASE_URL}/api/windows/info`)).json();
  assert.equal(info.downloadAvailable, true);
  const res = await fetch(`${BASE_URL}/download/windows`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://example.com/FoxyTimerSetup.exe');
});

test('trial: length setting, one trial per machine, offline-verifiable licence, extend', async () => {
  assert.equal((await post('/api/admin/windows-trials/settings', { trialDays: 0 }, adminCookie)).status, 400);
  assert.equal((await post('/api/admin/windows-trials/settings', { trialDays: 400 }, adminCookie)).status, 400);
  assert.equal((await post('/api/admin/windows-trials/settings', { trialDays: 7 }, adminCookie)).status, 200);

  assert.equal((await post('/api/windows/trial', { machineId: 'nope' })).status, 400);

  const before = Date.now();
  const first = await (await post('/api/windows/trial', { machineId: MACHINE, appVersion: '1.0.0' })).json();
  assert.equal(first.ok, true);
  assert.equal(first.started, true);
  assert.ok(Math.abs(first.expiresAt - (before + 7 * DAY)) < 5000);

  // Offline check in the app: right key + right machine only
  const status = trials.licenceStatus(first.licence, MACHINE, Date.now(), testPublicKey);
  assert.equal(status.status, 'active');
  assert.equal(status.daysLeft, 7);
  assert.equal(trials.licenceStatus(first.licence, 'cd'.repeat(32), Date.now(), testPublicKey).status, 'invalid');
  assert.equal(trials.licenceStatus(first.licence, MACHINE, first.expiresAt + 1, testPublicKey).status, 'expired');
  const [payload, sig] = first.licence.split('.');
  const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url')), expiresAt: first.expiresAt + 365 * DAY })).toString('base64url');
  assert.equal(trials.licenceStatus(`${tampered}.${sig}`, MACHINE, Date.now(), testPublicKey).status, 'invalid');

  // A longer setting doesn't change a trial that already started
  await post('/api/admin/windows-trials/settings', { trialDays: 30 }, adminCookie);
  const again = await (await post('/api/windows/trial', { machineId: MACHINE, appVersion: '1.0.1' })).json();
  assert.equal(again.started, false);
  assert.equal(again.expiresAt, first.expiresAt);

  // Admin sees it and extends it; the app picks up the new expiry
  const list = await (await fetch(`${BASE_URL}/api/admin/windows-trials`, { headers: { Cookie: adminCookie } })).json();
  assert.equal(list.settings.trialDays, 30);
  assert.equal(list.settings.signingConfigured, true);
  assert.equal(list.trials.length, 1);
  assert.equal(list.trials[0].app_version, '1.0.1');
  assert.equal((await fetch(`${BASE_URL}/api/admin/windows-trials`, { headers: { Cookie: userCookie } })).status, 403);

  const id = list.trials[0].id;
  assert.equal((await post(`/api/admin/windows-trials/${id}/extend`, { days: 10 }, userCookie)).status, 403);
  assert.equal((await post('/api/admin/windows-trials/99999/extend', { days: 10 }, adminCookie)).status, 404);
  const ext = await (await post(`/api/admin/windows-trials/${id}/extend`, { days: 10 }, adminCookie)).json();
  assert.equal(ext.trial.expires_at, first.expiresAt + 10 * DAY);
  const after = await (await post('/api/windows/trial', { machineId: MACHINE })).json();
  assert.equal(trials.licenceStatus(after.licence, MACHINE, Date.now(), testPublicKey).daysLeft, 17);
});

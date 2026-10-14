'use strict';

// Unit: the show laptop's trial logic (licence.js) with an in-memory meta
// store, a throwaway key pair and a fake Foxy Timer Online.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const trials = require('../trials');
const { createLicenceManager, CLOCK_TOLERANCE_MS } = require('../licence');

const DAY = 24 * 60 * 60 * 1000;
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

function setup({ clock = 1_800_000_000_000, expiresIn = 14 * DAY, online = true, meta = new Map() } = {}) {
  const t = { now: clock };
  let expiresAt = clock + expiresIn;
  const changes = [];
  const fetchImpl = async (url, opts) => {
    if (!online) throw new TypeError('fetch failed');
    const { machineId } = JSON.parse(opts.body);
    const licence = trials.signLicence({ id: 1, machine: machineId, issuedAt: clock, expiresAt }, privateKey);
    return { ok: true, status: 200, json: async () => ({ ok: true, licence, expiresAt }) };
  };
  const make = () => createLicenceManager({
    getMeta: (k) => (meta.has(k) ? meta.get(k) : null),
    setMeta: (k, v) => meta.set(k, v),
    fetchImpl,
    publicKey,
    onlineUrl: 'http://online.test',
    machineGuid: () => 'guid-1234',
    now: () => t.now,
    onChange: (info) => changes.push(info)
  });
  return { t, meta, make, changes, setExpiry: (v) => { expiresAt = v; }, setOnline: (v) => { online = v; } };
}

test('first launch offline: limited, no trial yet', async () => {
  const s = setup({ online: false });
  const lic = s.make();
  assert.equal(lic.info().status, 'none');
  assert.equal(lic.isLimited(), true);
  const after = await lic.checkIn();
  assert.equal(after.limited, true);
  assert.equal(after.lastCheckIn.ok, false);
});

test('first launch online: upgrades to full at once and stores the licence', async () => {
  const s = setup();
  const lic = s.make();
  assert.equal(lic.isLimited(), true);
  const info = await lic.checkIn();
  assert.equal(info.status, 'active');
  assert.equal(info.daysLeft, 14);
  assert.equal(lic.isLimited(), false);
  assert.equal(s.changes.length, 1);

  // Next start, offline: still full from the stored licence
  s.setOnline(false);
  const next = s.make();
  assert.equal(next.isLimited(), false);
  assert.equal(next.machineId, lic.machineId);
  assert.match(lic.machineId, /^[a-f0-9]{64}$/);
});

test('trial ends: limited from the next start, never mid-run', async () => {
  const s = setup();
  const lic = s.make();
  await lic.checkIn();
  s.t.now += 15 * DAY;
  await lic.checkIn(); // still the same licence; running app stays full
  assert.equal(lic.isLimited(), false);
  const next = s.make();
  assert.equal(next.info().status, 'expired');
  assert.equal(next.isLimited(), true);

  // Admin extends: the next check-in brings full back without a restart
  s.setExpiry(s.t.now + 10 * DAY);
  const info = await next.checkIn();
  assert.equal(info.status, 'active');
  assert.equal(info.daysLeft, 10);
  assert.equal(next.isLimited(), false);
});

test('clock wound back: limited', async () => {
  const s = setup();
  await s.make().checkIn();
  s.t.now += 3 * DAY;
  s.make(); // records the latest time seen
  s.t.now -= CLOCK_TOLERANCE_MS + 60 * 1000;
  const lic = s.make();
  assert.equal(lic.info().status, 'clock');
  assert.equal(lic.isLimited(), true);
});

test('a licence for another machine or signed by another key is ignored', async () => {
  const s = setup();
  const other = crypto.generateKeyPairSync('ed25519').privateKey;
  s.meta.set('windows_licence', trials.signLicence({ id: 1, machine: 'x'.repeat(64), issuedAt: 0, expiresAt: s.t.now + DAY }, privateKey));
  assert.equal(s.make().info().status, 'invalid');
  const lic = s.make();
  s.meta.set('windows_licence', trials.signLicence({ id: 1, machine: lic.machineId, issuedAt: 0, expiresAt: s.t.now + DAY }, other));
  assert.equal(s.make().info().status, 'invalid');
});

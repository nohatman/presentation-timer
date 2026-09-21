'use strict';

// Pure-logic tests for the Local Show Server launcher: LAN address choice, process
// safety rules, status classification, build fingerprints, room choice. Nothing
// here starts or kills a process.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lan = require('../tools/local-server/lib/lan');
const safe = require('../tools/local-server/lib/procsafe');
const { classifyStatus } = require('../tools/local-server/lib/status');
const { formatStatusLines } = require('../tools/local-server/lib/format');
const { pickRoom } = require('../tools/local-server/lib/rooms');
const buildInfo = require('../buildInfo');

// ---------------------------------------------------------------- LAN addresses
const v4 = (address, over = {}) => ({ address, family: 'IPv4', internal: false, ...over });

test('private ranges: 10/8, 172.16-31, 192.168 accepted; 172.15/172.32/public/garbage rejected', () => {
  for (const ok of ['192.168.0.5', '192.168.255.1', '10.0.0.1', '10.66.81.91', '172.16.0.1', '172.20.5.5', '172.31.255.254']) assert.equal(lan.isPrivateIPv4(ok), true, ok);
  for (const no of ['172.15.0.1', '172.32.0.1', '8.8.8.8', '100.96.164.26', '192.169.0.1', '11.0.0.1', '300.1.1.1', '1.2.3', '::1', '', null]) assert.equal(lan.isPrivateIPv4(no), false, String(no));
});

test('selectLanAddresses: any private network works - no subnet is assumed', () => {
  for (const ip of ['192.168.1.42', '10.20.30.40', '172.18.9.9']) {
    const r = lan.selectLanAddresses({ Ethernet: [v4(ip)] });
    assert.equal(r.primary.address, ip);
  }
});

test('selectLanAddresses: loopback, link-local (169.254), IPv6 and public/CGNAT addresses are never chosen', () => {
  const r = lan.selectLanAddresses({
    Loopback: [v4('127.0.0.1', { internal: true })],
    'Ethernet 2': [v4('169.254.10.10')],
    Tunnel: [v4('100.96.164.26')],
    Public: [v4('203.0.113.9')],
    V6: [{ address: 'fe80::1', family: 'IPv6', internal: false }],
  });
  assert.equal(r.primary, null);
  assert.deepEqual(r.candidates, []);
  assert.ok(r.ignored.some((i) => i.address === '169.254.10.10' && /link-local/.test(i.reason)));
  assert.ok(r.ignored.some((i) => i.address === '127.0.0.1'));
});

test('selectLanAddresses: real adapters outrank virtual ones (Hyper-V/WSL/VirtualBox/Docker/VPN), all remain listed', () => {
  const r = lan.selectLanAddresses({
    'vEthernet (WSL (Hyper-V firewall))': [v4('172.31.80.1')],
    'VirtualBox Host-Only Network': [v4('192.168.56.1')],
    'Wi-Fi': [v4('192.168.1.42')],
    Ethernet: [v4('10.66.81.91')],
  });
  assert.equal(r.primary.address, '192.168.1.42', 'first real adapter, original order');
  assert.deepEqual(r.candidates.map((c) => c.address), ['192.168.1.42', '10.66.81.91', '172.31.80.1', '192.168.56.1']);
  assert.deepEqual(r.candidates.map((c) => c.virtual), [false, false, true, true]);
});

test('selectLanAddresses: only-virtual machines still get an answer; numeric family (older Node) and empty input are handled', () => {
  assert.equal(lan.selectLanAddresses({ 'vEthernet (Default Switch)': [v4('172.25.0.1')] }).primary.address, '172.25.0.1');
  assert.equal(lan.selectLanAddresses({ eth0: [{ address: '10.1.1.1', family: 4, internal: false }] }).primary.address, '10.1.1.1');
  assert.equal(lan.selectLanAddresses({}).primary, null);
  assert.equal(lan.selectLanAddresses({ x: undefined }).primary, null);
});

// ---------------------------------------------------------------- process safety
const ENTRY = 'C:\\Users\\Op\\foxy\\server.js';
const goodInfo = (pid) => ({ pid, name: 'node.exe', commandLine: `"C:\\Program Files\\nodejs\\node.exe" "${ENTRY}"` });

test('canTerminateManaged: allowed only when PID file, OS command line and health all agree', () => {
  const record = { pid: 100 };
  assert.equal(safe.canTerminateManaged({ record, info: goodInfo(100), health: { pid: 100 }, expectedEntry: ENTRY }).ok, true);
  assert.equal(safe.canTerminateManaged({ record, info: goodInfo(100), health: null, expectedEntry: ENTRY }).ok, true, 'health optional for an unresponsive process we started');
  // path spelling differences do not matter
  assert.equal(safe.canTerminateManaged({ record, info: goodInfo(100), health: null, expectedEntry: 'c:/users/op/foxy/server.js' }).ok, true);
});

test('canTerminateManaged: refuses stale PID file, PID reuse by another program, other repos, and health-PID mismatch', () => {
  const record = { pid: 100 };
  const refuse = (args, re) => { const r = safe.canTerminateManaged({ expectedEntry: ENTRY, ...args }); assert.equal(r.ok, false); assert.match(r.reason, re); };
  refuse({ record: null, info: null, health: null }, /no PID record/);
  refuse({ record, info: null, health: null }, /stale PID file/);
  refuse({ record, info: { pid: 100, name: 'chrome.exe', commandLine: `chrome.exe ${ENTRY}` }, health: null }, /not this repo's node server/);
  refuse({ record, info: { pid: 100, name: 'node.exe', commandLine: 'node "C:\\other\\project\\server.js"' }, health: null }, /not this repo's node server/);
  refuse({ record, info: { pid: 100, name: 'node.exe', commandLine: 'node index.js' }, health: null }, /not this repo's node server/);
  refuse({ record, info: goodInfo(101), health: null }, /does not match/);
  refuse({ record, info: goodInfo(100), health: { pid: 999 } }, /answering on the port is PID 999/);
  refuse({ record: { pid: 'abc' }, info: goodInfo(100), health: null }, /no PID record/);
});

test('canForceTerminateUnmanaged: only a node process running server.js that owns the port', () => {
  const ok = safe.canForceTerminateUnmanaged({ info: { pid: 7, name: 'node.exe', commandLine: 'node  server.js' }, portOwnerPid: 7 });
  assert.equal(ok.ok, true);
  const no = (info, owner, re) => { const r = safe.canForceTerminateUnmanaged({ info, portOwnerPid: owner }); assert.equal(r.ok, false); assert.match(r.reason, re); };
  no(null, 7, /not found/);
  no({ pid: 7, name: 'node.exe', commandLine: 'node server.js' }, 8, /does not own the port/);
  no({ pid: 7, name: 'nginx.exe', commandLine: 'nginx server.js' }, 7, /not node/);
  no({ pid: 7, name: 'node.exe', commandLine: 'node other-app.js' }, 7, /not running a server\.js/);
  no({ pid: 7, name: 'node.exe', commandLine: 'node server.js' }, null, /does not own the port/);
});

test('parseNetstatListener: finds the LISTENING pid for a port on IPv4 and IPv6, ignores other states/ports', () => {
  const text = [
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1032',
    '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       12088',
    '  TCP    [::]:3977              [::]:0                 LISTENING       555',
    '  TCP    127.0.0.1:3977         127.0.0.1:50000        ESTABLISHED     556',
    '  TCP    10.0.0.5:39770         1.1.1.1:443            ESTABLISHED     557',
  ].join('\r\n');
  assert.equal(safe.parseNetstatListener(text, 3000), 12088);
  assert.equal(safe.parseNetstatListener(text, 3977), 555);
  assert.equal(safe.parseNetstatListener(text, 39770), null, 'established connection is not a listener');
  assert.equal(safe.parseNetstatListener(text, 8080), null);
  assert.equal(safe.parseNetstatListener('', 3000), null);
});

// ---------------------------------------------------------------- status classification
const HEALTH = (over = {}) => ({ ok: true, app: 'foxy-presentation-timer', pid: 100, mode: 'local', build: { fingerprint: 'aaaaaaaaaa' }, diskFingerprint: 'aaaaaaaaaa', stale: false, ...over });
const REC = { pid: 100 };
const base = { record: null, processInfo: null, identityOk: false, health: null, portOwner: null, diskFingerprint: 'aaaaaaaaaa' };

test('STOPPED: nothing running; a leftover PID file for a dead process is flagged and ignored', () => {
  assert.equal(classifyStatus(base).state, 'STOPPED');
  const stale = classifyStatus({ ...base, record: REC });
  assert.equal(stale.state, 'STOPPED');
  assert.equal(stale.stalePidFile, true);
});

test('RUNNING: launcher-started, identity verified, healthy, current build', () => {
  const s = classifyStatus({ ...base, record: REC, processInfo: goodInfo(100), identityOk: true, health: HEALTH(), portOwner: { pid: 100 } });
  assert.equal(s.state, 'RUNNING'); assert.equal(s.managed, true); assert.equal(s.stale, false);
});

test('STALE_BUILD: healthy but running older code (server says stale, OR fingerprints differ from disk)', () => {
  const common = { ...base, record: REC, processInfo: goodInfo(100), identityOk: true, portOwner: { pid: 100 } };
  assert.equal(classifyStatus({ ...common, health: HEALTH({ stale: true, diskFingerprint: 'bbbbbbbbbb' }) }).state, 'STALE_BUILD');
  const byLauncher = classifyStatus({ ...common, health: HEALTH(), diskFingerprint: 'bbbbbbbbbb' });
  assert.equal(byLauncher.state, 'STALE_BUILD');
  assert.match(byLauncher.detail, /aaaaaaaaaa.*bbbbbbbbbb/);
  assert.match(byLauncher.action, /Restart/);
});

test('UNHEALTHY: our process is alive and verified but not answering', () => {
  const s = classifyStatus({ ...base, record: REC, processInfo: goodInfo(100), identityOk: true, health: null, portOwner: { pid: 100 } });
  assert.equal(s.state, 'UNHEALTHY'); assert.equal(s.managed, true);
});

test('UNMANAGED: a Foxy server answers but was not started by the launcher (no PID file, or a different PID)', () => {
  assert.equal(classifyStatus({ ...base, health: HEALTH({ pid: 555, mode: 'hosted' }), portOwner: { pid: 555 } }).state, 'UNMANAGED');
  const other = classifyStatus({ ...base, record: REC, processInfo: goodInfo(100), identityOk: true, health: HEALTH({ pid: 555 }), portOwner: { pid: 555 } });
  assert.equal(other.state, 'UNMANAGED');
  assert.match(other.detail, /PID file says 100.*555/);
  assert.equal(other.managed, false);
});

test('PORT_CONFLICT: something else (incl. an OLD Foxy with no /api/health) holds the port; never treated as ours', () => {
  const s = classifyStatus({ ...base, health: null, portOwner: { pid: 12088 } });
  assert.equal(s.state, 'PORT_CONFLICT'); assert.equal(s.managed, false);
  assert.match(s.headline, /12088/);
  // a PID file pointing at an unrelated live process (PID reuse) must not make it "ours"
  const reused = classifyStatus({ ...base, record: REC, processInfo: { pid: 100, name: 'chrome.exe', commandLine: 'chrome' }, identityOk: false, health: null, portOwner: { pid: 4321 } });
  assert.equal(reused.state, 'PORT_CONFLICT');
  // a web server that is not Foxy counts as "not healthy Foxy"
  assert.equal(classifyStatus({ ...base, health: { ok: true, app: 'something-else', pid: 9 }, portOwner: { pid: 9 } }).state, 'PORT_CONFLICT');
});

test('formatStatusLines: shows state, port, LAN URL, build, and warns loudly about stale/other processes', () => {
  const st = {
    ...classifyStatus({ ...base, record: REC, processInfo: goodInfo(100), identityOk: true, health: HEALTH(), diskFingerprint: 'bbbbbbbbbb', portOwner: { pid: 100 } }),
    port: 3000, pid: 100, uptimeSec: 65, mode: 'local', localUrl: 'http://localhost:3000/', lanUrl: 'http://192.168.1.42:3000/',
    lan: { primary: { name: 'Wi-Fi', address: '192.168.1.42' }, candidates: [{ name: 'Wi-Fi', address: '192.168.1.42' }], ignored: [] },
    runningBuild: { label: 'abc1234 / aaaaaaaaaa' }, diskFingerprint: 'bbbbbbbbbb', diskBuild: { label: 'abc1234+edits / bbbbbbbbbb' },
    otherProcesses: [{ pid: 40952, commandLine: 'node  server.js' }], logFile: 'C:\\x\\server.log',
  };
  const text = formatStatusLines(st).join('\n');
  assert.match(text, /STALE BUILD/);
  assert.match(text, /Port:\s+3000\s+PID: 100\s+Up: 1m 5s/);
  assert.match(text, /http:\/\/192\.168\.1\.42:3000\//);
  assert.match(text, /running abc1234 \/ aaaaaaaaaa\s+on disk abc1234\+edits \/ bbbbbbbbbb/);
  assert.match(text, /PID 40952: node  server\.js/);
});

// ---------------------------------------------------------------- build fingerprint
function tmpRoot(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foxy-fp-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

test('fingerprint: stable for identical files, changes when a server-side file changes, ignores line-ending style', () => {
  const files = ['a.js', 'b.js'];
  const a = tmpRoot({ 'a.js': 'one\ntwo\n', 'b.js': 'x' });
  const same = tmpRoot({ 'a.js': 'one\ntwo\n', 'b.js': 'x' });
  const crlf = tmpRoot({ 'a.js': 'one\r\ntwo\r\n', 'b.js': 'x' });
  const edited = tmpRoot({ 'a.js': 'one\ntwo!\n', 'b.js': 'x' });
  const fp = (d) => buildInfo.computeFingerprint(d, files).fingerprint;
  assert.equal(fp(a), fp(same));
  assert.equal(fp(a), fp(crlf), 'git autocrlf must not look like a code change');
  assert.notEqual(fp(a), fp(edited));
  assert.match(fp(a), /^[0-9a-f]{10}$/);
});

test('fingerprint: a missing file is reported and changes the fingerprint; unknown never counts as a match', () => {
  const d = tmpRoot({ 'a.js': '1' });
  const r = buildInfo.computeFingerprint(d, ['a.js', 'gone.js']);
  assert.deepEqual(r.missing, ['gone.js']);
  assert.notEqual(r.fingerprint, buildInfo.computeFingerprint(d, ['a.js']).fingerprint);
  assert.equal(buildInfo.fingerprintsMatch('abc', 'abc'), true);
  for (const [x, y] of [['abc', 'abd'], ['', ''], [null, null], [undefined, 'abc'], ['abc', undefined]]) assert.equal(buildInfo.fingerprintsMatch(x, y), false);
});

test('the real server-side fingerprint covers every file server.js loads from the repo root', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const required = [...src.matchAll(/require\('\.\/([\w-]+)'\)/g)].map((m) => `${m[1]}.js`);
  assert.ok(required.length >= 4);
  for (const f of required) assert.ok(buildInfo.FINGERPRINT_FILES.includes(f), `${f} is required by server.js but not fingerprinted`);
  assert.deepEqual(buildInfo.computeFingerprint().missing, []);
});

test('getBuildInfo: label shows commit (+edits) and fingerprint; falls back to FOXY_BUILD_ID outside git', () => {
  const d = tmpRoot({});
  const saved = process.env.FOXY_BUILD_ID;
  process.env.FOXY_BUILD_ID = 'deadbeefcafe';
  try {
    const info = buildInfo.getBuildInfo(d);
    assert.equal(info.commit, 'deadbee');
    assert.match(info.label, /^deadbee \/ [0-9a-f]{10}$/);
  } finally { if (saved === undefined) delete process.env.FOXY_BUILD_ID; else process.env.FOXY_BUILD_ID = saved; }
  assert.equal(buildInfo.formatLabel({ commit: null, dirty: true, fingerprint: 'f' }), 'no-git+edits / f');
});

// ---------------------------------------------------------------- room choice
test('pickRoom: explicit slug wins; a single room is unambiguous; several need a choice (or a remembered one)', () => {
  const rooms = [{ slug: 'main' }, { slug: 'breakout' }];
  assert.equal(pickRoom([], {}).room, null);
  assert.equal(pickRoom([{ slug: 'only' }], {}).room.slug, 'only');
  assert.equal(pickRoom(rooms, { slug: 'breakout' }).room.slug, 'breakout');
  assert.equal(pickRoom(rooms, { slug: 'nope' }).notFound, 'nope');
  assert.equal(pickRoom(rooms, {}).room, null);
  assert.equal(pickRoom(rooms, {}).choices.length, 2);
  assert.equal(pickRoom(rooms, { lastSlug: 'main' }).room.slug, 'main');
  assert.equal(pickRoom(rooms, { lastSlug: 'deleted' }).room, null);
});

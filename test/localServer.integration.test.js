'use strict';

// Integration: the REAL launcher/supervisor driving REAL server.js processes on a
// scratch port with scratch data (never port 3000, never the real database), plus
// "decoy" processes proving the launcher cannot be tricked into stopping anything
// that is not the Foxy server it manages. Windows-oriented (PowerShell/netstat),
// so it is skipped elsewhere.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const sup = require('../tools/local-server/lib/supervisor');
const osproc = require('../tools/local-server/lib/osproc');

const SKIP = process.platform !== 'win32' ? 'Windows-only launcher integration' : false;
const ROOT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foxy-local-it-'));
process.env.DATABASE_PATH = path.join(tmp, 'db.sqlite');                      // scratch DB, inherited by spawned servers
process.env.LEGACY_ROOMS_JSON_PATH = path.join(tmp, 'no-such-rooms.json');
process.env.FOXY_NO_BROWSER = '1';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

const decoys = [];
function spawnDecoy(code, args = []) {
  const child = spawn(process.execPath, ['-e', code, ...args], { stdio: 'ignore', windowsHide: true });
  decoys.push(child);
  return child;
}
const alive = (pid) => osproc.isPidAlive(pid);

let cfg; let port;
let n = 0;
async function freshCfg() {
  port = await freePort();
  n += 1;
  cfg = sup.makeConfig({ port, dataDir: path.join(tmp, `ls${n}`), startTimeoutMs: 30000, stopTimeoutMs: 10000 });
  return cfg;
}

test.after(async () => {
  try { if (cfg) await sup.stop(cfg, { forceUnmanaged: true }); } catch { /* best effort */ }
  for (const d of decoys) { try { d.kill(); } catch { /* gone */ } }
  await sleep(200);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('lifecycle: stopped -> start -> healthy -> no second copy -> restart changes the process -> stop -> stopped -> start again', { skip: SKIP, timeout: 240000 }, async () => {
  await freshCfg();

  let st = await sup.gatherStatus(cfg);
  assert.equal(st.state, 'STOPPED');

  const s1 = await sup.start(cfg);
  assert.equal(s1.ok, true, s1.message);
  assert.equal(s1.action, 'started');
  const pid1 = s1.pid;
  st = await sup.gatherStatus(cfg);
  assert.equal(st.state, 'RUNNING');
  assert.equal(st.managed, true);
  assert.equal(st.pid, pid1);
  assert.equal(st.mode, 'local');
  assert.equal(st.port, port);
  assert.match(st.runningBuild.fingerprint, /^[0-9a-f]{10}$/);
  assert.equal(st.runningBuild.fingerprint, st.diskFingerprint, 'a fresh server matches the files on disk');
  assert.ok(st.lanUrl === null || /^http:\/\/(10|172|192)\./.test(st.lanUrl));

  // starting again must NOT create a second copy
  const again = await sup.start(cfg);
  assert.equal(again.ok, true);
  assert.equal(again.action, 'already-running');
  assert.equal((await sup.gatherStatus(cfg)).pid, pid1);
  assert.equal(osproc.getPortOwner(port).pid, pid1);

  // the shutdown door is closed to anything but the launcher's token
  for (const headers of [{}, { 'x-foxy-shutdown-token': 'wrong' }]) {
    const r = await fetch(`http://127.0.0.1:${port}/api/local/shutdown`, { method: 'POST', headers });
    assert.equal(r.status, 403);
  }
  assert.equal(alive(pid1), true);

  // restart: new process, still healthy
  const r = await sup.restart(cfg);
  assert.equal(r.ok, true, r.message);
  const pid2 = r.pid;
  assert.notEqual(pid2, pid1);
  assert.equal(alive(pid1), false, 'old process is gone');
  st = await sup.gatherStatus(cfg);
  assert.equal(st.state, 'RUNNING');
  assert.equal(st.pid, pid2);

  // stale/mismatched build is called out (simulated: pretend the files on disk changed)
  const stale = await sup.gatherStatus(cfg, { diskFingerprint: 'deadbeef00' });
  assert.equal(stale.state, 'STALE_BUILD');
  assert.match(stale.action, /Restart/);

  // the server itself reports its own staleness through /api/health
  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  assert.equal(health.app, 'foxy-presentation-timer');
  assert.equal(health.pid, pid2);
  assert.equal(health.stale, false);

  const stopped = await sup.stop(cfg);
  assert.equal(stopped.ok, true, stopped.message);
  assert.match(stopped.message, /clean shutdown/);
  assert.equal(alive(pid2), false);
  assert.equal(fs.existsSync(cfg.pidFile), false, 'PID file removed');
  st = await sup.gatherStatus(cfg);
  assert.equal(st.state, 'STOPPED');
  assert.equal(osproc.getPortOwner(port), null);

  const s3 = await sup.start(cfg);
  assert.equal(s3.ok, true, s3.message);
  assert.equal((await sup.gatherStatus(cfg)).state, 'RUNNING');
  assert.equal((await sup.stop(cfg)).ok, true);
});

test('safety: a PID file that points at an unrelated live node process is never trusted or killed', { skip: SKIP, timeout: 120000 }, async () => {
  await freshCfg();
  const innocent = spawnDecoy('setInterval(() => {}, 1000)');
  await sleep(500);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(cfg.pidFile, JSON.stringify({ pid: innocent.pid, port, token: 'x', startedAt: new Date().toISOString(), entry: cfg.entry }));

  let st = await sup.gatherStatus(cfg);
  assert.equal(st.state, 'STOPPED', 'PID reuse by another program is not "our server"');
  assert.equal(st.managed, false);

  const stopped = await sup.stop(cfg);
  assert.equal(stopped.ok, true);
  assert.equal(alive(innocent.pid), true, 'stop did not touch the unrelated process');

  const started = await sup.start(cfg);          // overwrites the bad PID file with the real one
  assert.equal(started.ok, true, started.message);
  assert.notEqual(started.pid, innocent.pid);
  assert.equal(alive(innocent.pid), true);
  assert.equal((await sup.stop(cfg)).ok, true);
  assert.equal(alive(innocent.pid), true, 'unrelated node process survived a full start/stop cycle');
});

test('safety: a stale PID file (process long gone) is ignored and cleaned up', { skip: SKIP, timeout: 120000 }, async () => {
  await freshCfg();
  const dead = spawnDecoy('0');
  await new Promise((resolve) => dead.on('exit', resolve));
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(cfg.pidFile, JSON.stringify({ pid: dead.pid, port, token: 'x', startedAt: new Date().toISOString(), entry: cfg.entry }));
  const st = await sup.gatherStatus(cfg);
  assert.equal(st.state, 'STOPPED');
  assert.equal(st.stalePidFile, true);
  const r = await sup.stop(cfg);
  assert.equal(r.action, 'already-stopped');
  assert.equal(fs.existsSync(cfg.pidFile), false);
});

test('safety: another program on the port => start refuses, stop refuses, forced stop refuses a non-server.js process; decoy survives', { skip: SKIP, timeout: 120000 }, async () => {
  await freshCfg();
  const squatter = spawnDecoy(`require('net').createServer().listen(${port})`);
  for (let i = 0; i < 40 && !osproc.getPortOwner(port); i++) await sleep(150);
  assert.equal(osproc.getPortOwner(port).pid, squatter.pid);

  const st = await sup.gatherStatus(cfg);
  assert.equal(st.state, 'PORT_CONFLICT');
  assert.equal(st.portOwner.pid, squatter.pid);

  const start = await sup.start(cfg);
  assert.equal(start.ok, false);
  assert.match(start.message, /in use/);
  const stop = await sup.stop(cfg);
  assert.equal(stop.ok, false);
  const forced = await sup.stop(cfg, { forceUnmanaged: true });
  assert.equal(forced.ok, false, 'a node process that is not running server.js must not be force-stopped');
  assert.match(forced.message, /not running a server\.js/);
  assert.equal(alive(squatter.pid), true, 'the other program was never touched');
  assert.equal(fs.existsSync(cfg.pidFile), false, 'no PID file was created for a server we did not start');
});

test('unmanaged Foxy: a hand-started server.js is reported, not adopted or silently killed; explicit force stops only it', { skip: SKIP, timeout: 180000 }, async () => {
  await freshCfg();
  const bystander = spawnDecoy('setInterval(() => {}, 1000)');
  const manual = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port) }, stdio: 'ignore', windowsHide: true });
  decoys.push(manual);
  for (let i = 0; i < 60; i++) { if ((await sup.fetchHealth(port, 500)).health) break; await sleep(300); }

  const st = await sup.gatherStatus(cfg);
  assert.equal(st.state, 'UNMANAGED');
  assert.equal(st.managed, false);
  assert.equal(st.mode, 'hosted', 'not started by the launcher, so not in local mode');

  const start = await sup.start(cfg);
  assert.equal(start.ok, false, 'no second copy on top of an unmanaged one');
  const plainStop = await sup.stop(cfg);
  assert.equal(plainStop.ok, false, 'not stopped without an explicit request');
  assert.equal(alive(manual.pid), true);

  const forced = await sup.stop(cfg, { forceUnmanaged: true });
  assert.equal(forced.ok, true, forced.message);
  assert.equal(alive(manual.pid), false);
  assert.equal(alive(bystander.pid), true, 'an unrelated node process was not touched');
  assert.equal((await sup.gatherStatus(cfg)).state, 'STOPPED');
});

test('failure is explained: a start that cannot bind reports the log instead of hanging', { skip: SKIP, timeout: 120000 }, async () => {
  await freshCfg();
  cfg.startTimeoutMs = 8000;
  // Break the server on purpose via an unusable database path; it should exit and the launcher should say so.
  const saved = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = path.join(tmp, 'a-file-not-a-dir', 'x', 'db.sqlite');
  fs.writeFileSync(path.join(tmp, 'a-file-not-a-dir'), 'blocker');
  try {
    const r = await sup.start(cfg);
    assert.equal(r.ok, false);
    assert.match(r.message, /exited immediately|did not become healthy/);
    assert.match(r.message, /Last log lines/);
    assert.equal(fs.existsSync(cfg.pidFile), false, 'no PID file left behind');
    assert.equal((await sup.gatherStatus(cfg)).state, 'STOPPED');
  } finally { process.env.DATABASE_PATH = saved; }
});

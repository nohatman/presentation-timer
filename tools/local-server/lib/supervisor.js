'use strict';

// Start / stop / restart / status of THE Foxy Local Show Server for this repo.
//
// Identity model (nothing is killed on a PID alone):
//   1. the PID file written by this launcher   { pid, port, token, startedAt, entry }
//   2. the OS process for that PID is `node` and its command line names this
//      repo's server.js (the launcher always starts it as `node "<abs>\server.js"`)
//   3. the server answering /api/health on the port reports the same PID
// Only when all agree is it "managed" and safe to stop. A Foxy server started by
// hand, or something else holding the port, is reported, never silently killed.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const buildInfo = require('../../../buildInfo');
const { selectLanAddresses } = require('./lan');
const { classifyStatus } = require('./status');
const { canTerminateManaged, canForceTerminateUnmanaged } = require('./procsafe');
const osproc = require('./osproc');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeConfig(opts = {}) {
  const rootDir = opts.rootDir || path.resolve(__dirname, '..', '..', '..');
  const port = Number(opts.port || process.env.FOXY_PORT || process.env.PORT || 3000);
  const dataDir = opts.dataDir || process.env.FOXY_LOCAL_DATA_DIR || path.join(rootDir, 'data', 'local-server');
  return {
    rootDir, port, dataDir,
    entry: path.join(rootDir, 'server.js'),
    pidFile: path.join(dataDir, 'server.pid.json'),
    logFile: path.join(dataDir, 'server.log'),
    startTimeoutMs: opts.startTimeoutMs || 20000,
    stopTimeoutMs: opts.stopTimeoutMs || 8000,
  };
}

function readRecord(cfg) {
  try {
    const r = JSON.parse(fs.readFileSync(cfg.pidFile, 'utf8'));
    return Number.isInteger(r.pid) ? r : null;
  } catch { return null; }
}
function writeRecord(cfg, rec) {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(cfg.pidFile, JSON.stringify(rec, null, 2));
}
function removeRecord(cfg) { try { fs.unlinkSync(cfg.pidFile); } catch { /* already gone */ } }

// -> parsed /api/health when a Foxy server answers, else null. `reason` explains why not.
async function fetchHealth(port, timeoutMs = 2000) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
    if (!res.ok) return { health: null, reason: `HTTP ${res.status} from /api/health (server predates health reporting, or is not Foxy)` };
    const h = await res.json();
    if (!h || h.app !== 'foxy-presentation-timer') return { health: null, reason: 'a web server answered, but it is not Foxy' };
    return { health: h, reason: null };
  } catch (e) {
    return { health: null, reason: e.name === 'TimeoutError' ? 'no answer within timeout' : 'connection refused / no web server' };
  }
}

// Everything the operator screen needs. `opts.diskFingerprint` lets tests simulate
// a changed build without editing real files.
async function gatherStatus(cfg, opts = {}) {
  const record = readRecord(cfg);
  const { health, reason: healthReason } = await fetchHealth(cfg.port);
  const portOwner = osproc.getPortOwner(cfg.port);
  const processInfo = record ? osproc.getProcessInfo(record.pid) : null;
  const ownerPid = portOwner ? portOwner.pid : null;
  const ownerInfo = ownerPid ? (processInfo && processInfo.pid === ownerPid ? processInfo : osproc.getProcessInfo(ownerPid)) : null;
  const disk = opts.diskFingerprint ? { fingerprint: opts.diskFingerprint } : buildInfo.computeFingerprint(cfg.rootDir);
  const identity = record ? canTerminateManaged({ record, info: processInfo, health, expectedEntry: cfg.entry }) : { ok: false, reason: 'no PID record' };

  const c = classifyStatus({ record, processInfo, identityOk: identity.ok, health, portOwner, diskFingerprint: disk.fingerprint });
  const lan = selectLanAddresses();
  const others = c.state === 'RUNNING' && !opts.full ? [] :
    osproc.listNodeServerProcesses().filter((p) => !(record && p.pid === record.pid) && !(health && p.pid === health.pid));

  return {
    ...c,
    port: cfg.port,
    pid: health ? health.pid : (record && processInfo ? record.pid : null),
    mode: health ? health.mode : null,
    startedAt: health ? health.startedAt : (record ? record.startedAt : null),
    uptimeSec: health ? health.uptimeSec : null,
    runningBuild: health ? health.build : null,
    diskFingerprint: disk.fingerprint,
    diskBuild: opts.diskFingerprint ? null : buildInfo.getBuildInfo(cfg.rootDir),
    healthNote: health ? null : healthReason,
    portOwner: ownerPid ? { pid: ownerPid, name: ownerInfo && ownerInfo.name, commandLine: ownerInfo && ownerInfo.commandLine } : null,
    otherProcesses: others,
    identityNote: identity.reason,
    localUrl: `http://localhost:${cfg.port}/`,
    lan,
    lanUrl: lan.primary ? `http://${lan.primary.address}:${cfg.port}/` : null,
    logFile: cfg.logFile,
    pidFile: cfg.pidFile,
    _record: record, _processInfo: processInfo, _health: health, _ownerInfo: ownerInfo,
  };
}

function tailLog(cfg, lines = 15) {
  try { return fs.readFileSync(cfg.logFile, 'utf8').split(/\r?\n/).filter(Boolean).slice(-lines).join('\n'); } catch { return '(no log)'; }
}

function rotateLog(cfg) {
  try { if (fs.statSync(cfg.logFile).size > 2 * 1024 * 1024) fs.renameSync(cfg.logFile, cfg.logFile + '.old'); } catch { /* no log yet */ }
}

async function start(cfg, opts = {}) {
  const st = await gatherStatus(cfg, opts);
  if (st.managed && ['RUNNING', 'STALE_BUILD', 'UNHEALTHY'].includes(st.state)) {
    return { ok: true, action: 'already-running', status: st, message: `Already running (PID ${st.pid}); not starting a second copy.` };
  }
  if (st.state === 'UNMANAGED') return { ok: false, action: 'refused', status: st, message: `${st.headline}. ${st.action}` };
  if (st.state === 'PORT_CONFLICT') return { ok: false, action: 'refused', status: st, message: `Port ${cfg.port}: ${st.headline}.` };
  if (st.stalePidFile) removeRecord(cfg);

  fs.mkdirSync(cfg.dataDir, { recursive: true });
  rotateLog(cfg);
  const logFd = fs.openSync(cfg.logFile, 'a');
  fs.writeSync(logFd, `\n=== Foxy Local Show Server start ${new Date().toISOString()} (port ${cfg.port}) ===\n`);
  const token = crypto.randomBytes(18).toString('hex');
  const child = spawn(process.execPath, [cfg.entry], {
    cwd: cfg.rootDir,
    detached: true,            // survives the launcher window being closed
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, PORT: String(cfg.port), FOXY_MODE: 'local', FOXY_SHUTDOWN_TOKEN: token },
  });
  child.unref();
  fs.closeSync(logFd);
  writeRecord(cfg, { pid: child.pid, port: cfg.port, token, startedAt: new Date().toISOString(), entry: cfg.entry });

  const deadline = Date.now() + cfg.startTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(300);
    if (!osproc.isPidAlive(child.pid)) {
      removeRecord(cfg);
      return { ok: false, action: 'failed', message: `The server exited immediately. Last log lines:\n${tailLog(cfg)}` };
    }
    const { health } = await fetchHealth(cfg.port, 1000);
    if (health && health.pid === child.pid) {
      return { ok: true, action: 'started', pid: child.pid, status: await gatherStatus(cfg, opts), message: `Started (PID ${child.pid}).` };
    }
  }
  // We spawned this process ourselves a moment ago, so cleaning it up is safe.
  try { process.kill(child.pid); } catch { /* already gone */ }
  removeRecord(cfg);
  return { ok: false, action: 'failed', message: `The server did not become healthy within ${cfg.startTimeoutMs / 1000}s and was stopped. Last log lines:\n${tailLog(cfg)}` };
}

async function waitGone(pid, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (!osproc.isPidAlive(pid)) return true; await sleep(200); }
  return !osproc.isPidAlive(pid);
}

async function stop(cfg, opts = {}) {
  const st = await gatherStatus(cfg, opts);
  if (st.state === 'STOPPED') {
    removeRecord(cfg);
    return { ok: true, action: 'already-stopped', status: st, message: 'Already stopped.' };
  }

  if (st.managed) {
    const verdict = canTerminateManaged({ record: st._record, info: st._processInfo, health: st._health, expectedEntry: cfg.entry });
    if (!verdict.ok) return { ok: false, action: 'refused', status: st, message: `Refusing to stop: ${verdict.reason}.` };
    const pid = st._record.pid;
    let how = 'clean shutdown';
    try {
      const res = await fetch(`http://127.0.0.1:${cfg.port}/api/local/shutdown`, {
        method: 'POST', headers: { 'x-foxy-shutdown-token': st._record.token || '' }, signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) how = `shutdown request refused (HTTP ${res.status})`;
    } catch { how = 'shutdown request not answered'; }
    if (!(await waitGone(pid, cfg.stopTimeoutMs))) {
      // Re-verify identity immediately before any forceful action.
      const again = canTerminateManaged({ record: st._record, info: osproc.getProcessInfo(pid), health: null, expectedEntry: cfg.entry });
      if (!again.ok) return { ok: false, action: 'refused', message: `Did not stop, and will not force it: ${again.reason}.` };
      try { process.kill(pid); how = `forced (${how})`; } catch { /* raced with exit */ }
      if (!(await waitGone(pid, 3000))) return { ok: false, action: 'failed', message: `PID ${pid} would not exit.` };
    }
    removeRecord(cfg);
    return { ok: true, action: 'stopped', pid, message: `Stopped PID ${pid} (${how}).` };
  }

  // Not ours. Only ever on explicit request, and only for a node server.js that owns the port.
  if (!opts.forceUnmanaged) {
    return { ok: false, action: 'refused', status: st, message: `Not stopping: ${st.headline}. It was not started by this launcher. ${st.action}` };
  }
  const owner = st.portOwner;
  const verdict = canForceTerminateUnmanaged({ info: st._ownerInfo, portOwnerPid: owner && owner.pid });
  if (!verdict.ok) return { ok: false, action: 'refused', status: st, message: `Refusing to stop PID ${owner ? owner.pid : '?'}: ${verdict.reason}.` };
  try { process.kill(owner.pid); } catch (e) { return { ok: false, action: 'failed', message: `Could not stop PID ${owner.pid}: ${e.message}` }; }
  if (!(await waitGone(owner.pid, 5000))) return { ok: false, action: 'failed', message: `PID ${owner.pid} would not exit.` };
  return { ok: true, action: 'stopped-unmanaged', pid: owner.pid, message: `Stopped unmanaged server PID ${owner.pid}. (It could not save state cleanly - a change in the last half second may be lost.)` };
}

async function restart(cfg, opts = {}) {
  const before = await gatherStatus(cfg, opts);
  if (before.state !== 'STOPPED') {
    const stopped = await stop(cfg, opts);
    if (!stopped.ok) return stopped;
  }
  const started = await start(cfg, opts);
  if (started.ok && before.pid && started.pid === before.pid) {
    return { ok: false, action: 'failed', message: 'Restart did not change the process (same PID).' };
  }
  return { ...started, oldPid: before.pid || null, message: started.ok ? `Restarted: PID ${before.pid || '-'} -> ${started.pid}.` : started.message };
}

module.exports = { makeConfig, gatherStatus, fetchHealth, start, stop, restart, readRecord, tailLog };

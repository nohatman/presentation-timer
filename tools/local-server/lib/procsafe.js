'use strict';

// Rules for when the launcher may terminate a process. Pure functions: all the
// facts (from the PID file, the OS process table, the health endpoint, the port
// table) are passed in, so the safety logic is testable without killing anything.
//
// The launcher starts the server as `node "<abs path>\server.js"` so its command
// line names THIS repo's server file unambiguously. It only ever terminates a
// process when every identity check agrees; otherwise it refuses and explains.

// 'C:\A\B\server.js' vs 'c:/a/b/server.js' -> same string.
function normPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/"/g, '').toLowerCase();
}

function isNodeImage(name) {
  return /^node(\.exe)?$/i.test(String(name || ''));
}

// info: { pid, name, commandLine } from the OS, or null if the process is gone.
function commandLineNamesEntry(info, expectedEntry) {
  return !!info && isNodeImage(info.name) && normPath(info.commandLine).includes(normPath(expectedEntry));
}

// May the launcher stop the server it recorded in its PID file?
//   record: PID file contents { pid, ... }
//   info:   OS view of record.pid (null => not running)
//   health: parsed /api/health of the port, or null if it did not answer
function canTerminateManaged({ record, info, health, expectedEntry }) {
  if (!record || !Number.isInteger(record.pid)) return { ok: false, reason: 'no PID record' };
  if (!info) return { ok: false, reason: `PID ${record.pid} is not running (stale PID file)` };
  if (info.pid !== record.pid) return { ok: false, reason: 'OS process does not match the PID file' };
  if (!commandLineNamesEntry(info, expectedEntry)) {
    return { ok: false, reason: `PID ${record.pid} is not this repo's node server (PID reused by another program?)` };
  }
  if (health && Number.isInteger(health.pid) && health.pid !== record.pid) {
    return { ok: false, reason: `the server answering on the port is PID ${health.pid}, not PID ${record.pid}` };
  }
  return { ok: true, reason: 'PID, command line and health identity agree' };
}

// Explicit, operator-confirmed removal of a server the launcher did NOT start (an
// older/hand-started `node server.js` holding the port). Much narrower than "kill
// node": it must be the very process that owns the listening socket, be a node
// image, and have a command line that runs a server.js.
function canForceTerminateUnmanaged({ info, portOwnerPid }) {
  if (!info) return { ok: false, reason: 'process not found' };
  if (!Number.isInteger(portOwnerPid) || info.pid !== portOwnerPid) return { ok: false, reason: 'process does not own the port' };
  if (!isNodeImage(info.name)) return { ok: false, reason: `${info.name} is not node - refusing to stop an unrelated program` };
  if (!/server\.js/i.test(String(info.commandLine || ''))) return { ok: false, reason: 'node process is not running a server.js - refusing' };
  return { ok: true, reason: 'node server.js that owns the port' };
}

// `netstat -ano -p TCP` output -> pid listening on `port` (or null). IPv4 and IPv6.
function parseNetstatListener(text, port) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    if (m && Number(m[2]) === Number(port)) return Number(m[3]);
  }
  return null;
}

module.exports = { normPath, isNodeImage, commandLineNamesEntry, canTerminateManaged, canForceTerminateUnmanaged, parseNetstatListener };

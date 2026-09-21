'use strict';

// Thin, side-effect-only wrappers over the OS: process table, port table, opening
// a browser. Kept separate from the decision logic (status.js / procsafe.js) so
// that logic stays pure. Windows first (PowerShell + netstat); a plain `ps`
// fallback keeps the tool usable elsewhere for development.

const { execFileSync, spawn } = require('child_process');
const { parseNetstatListener } = require('./procsafe');

const IS_WIN = process.platform === 'win32';

function run(file, args, timeout = 10000) {
  return execFileSync(file, args, { timeout, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function powershell(script) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], 15000);
}

// -> { pid, name, commandLine } or null when there is no such process.
function getProcessInfo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (IS_WIN) {
      const out = powershell(`$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p) { $p | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress }`).trim();
      if (!out) return null;
      const o = JSON.parse(out);
      return { pid: Number(o.ProcessId), name: o.Name || '', commandLine: o.CommandLine || '' };
    }
    const args = run('ps', ['-p', String(pid), '-o', 'args=']).trim();
    const comm = run('ps', ['-p', String(pid), '-o', 'comm=']).trim();
    return args ? { pid, name: comm.split('/').pop(), commandLine: args } : null;
  } catch {
    return null;
  }
}

// Every node process whose command line mentions server.js - INFORMATION ONLY
// (shown so a hand-started or forgotten server is visible). Never used to decide
// what to terminate.
function listNodeServerProcesses() {
  try {
    if (IS_WIN) {
      const out = powershell(`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'server\\.js' } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`).trim();
      if (!out) return [];
      const parsed = JSON.parse(out);
      return (Array.isArray(parsed) ? parsed : [parsed]).map((o) => ({ pid: Number(o.ProcessId), name: o.Name, commandLine: o.CommandLine || '' }));
    }
    return run('ps', ['-eo', 'pid=,comm=,args=']).split('\n').map((l) => l.trim()).filter((l) => /node/.test(l) && /server\.js/.test(l))
      .map((l) => { const m = /^(\d+)\s+(\S+)\s+(.*)$/.exec(l); return m ? { pid: Number(m[1]), name: m[2], commandLine: m[3] } : null; }).filter(Boolean);
  } catch {
    return [];
  }
}

// -> { pid } of the process LISTENING on `port`, or null.
function getPortOwner(port) {
  try {
    if (IS_WIN) {
      const pid = parseNetstatListener(run('netstat.exe', ['-ano', '-p', 'TCP']), port);
      return pid ? { pid } : null;
    }
    const out = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']).trim().split('\n')[0];
    return out ? { pid: Number(out) } : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Opens a URL in the default browser. FOXY_NO_BROWSER=1 only prints (tests/CI).
function openUrl(url) {
  if (process.env.FOXY_NO_BROWSER) return false;
  const opts = { detached: true, stdio: 'ignore', windowsHide: true };
  const child = IS_WIN ? spawn('cmd.exe', ['/c', 'start', '', url], opts)
    : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], opts);
  child.unref();
  return true;
}

module.exports = { getProcessInfo, listNodeServerProcesses, getPortOwner, isPidAlive, openUrl };

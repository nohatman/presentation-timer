'use strict';

// Operator-facing text for a status object from supervisor.gatherStatus().

const LABELS = {
  STOPPED: 'STOPPED',
  RUNNING: 'RUNNING',
  STALE_BUILD: 'RUNNING - STALE BUILD (restart needed)',
  UNHEALTHY: 'UNHEALTHY',
  UNMANAGED: 'RUNNING - NOT STARTED BY THIS LAUNCHER',
  PORT_CONFLICT: 'PORT IN USE BY ANOTHER PROCESS',
};

function fmtUptime(sec) {
  if (!Number.isFinite(sec)) return '-';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}

function formatStatusLines(st) {
  const L = [];
  L.push(`Status:   ${LABELS[st.state] || st.state}`);
  L.push(`          ${st.headline}`);
  if (st.detail) L.push(`          ${st.detail}`);
  L.push(`Port:     ${st.port}${st.pid ? `    PID: ${st.pid}` : ''}${Number.isFinite(st.uptimeSec) ? `    Up: ${fmtUptime(st.uptimeSec)}` : ''}${st.mode ? `    Mode: ${st.mode}` : ''}`);
  if (st.state !== 'STOPPED') {
    L.push(`This PC:  ${st.localUrl}`);
    if (st.lanUrl) {
      L.push(`Other devices on the LAN:  ${st.lanUrl}   (${st.lan.primary.name})`);
      const more = st.lan.candidates.slice(1);
      if (more.length) L.push(`          other addresses: ${more.map((c) => `http://${c.address}:${st.port}/ (${c.name}${c.virtual ? ', virtual' : ''})`).join('  ')}`);
    } else {
      L.push('Other devices on the LAN:  NO PRIVATE LAN ADDRESS FOUND - is this PC connected to the show network?');
    }
  } else if (st.lanUrl) {
    L.push(`Will be reachable at:  ${st.lanUrl}   (${st.lan.primary.name})`);
  } else {
    L.push('LAN:      NO PRIVATE LAN ADDRESS FOUND - is this PC connected to the show network?');
  }
  if (st.lan.ignored.length && st.state !== 'RUNNING') {
    const notable = st.lan.ignored.filter((i) => i.reason !== 'loopback');
    if (notable.length) L.push(`          skipped: ${notable.map((i) => `${i.address} (${i.name}: ${i.reason})`).join('; ')}`);
  }
  if (st.runningBuild) L.push(`Build:    running ${st.runningBuild.label}` + (st.diskBuild ? `   on disk ${st.diskBuild.label}` : `   on disk ${st.diskFingerprint}`));
  else if (st.diskBuild) L.push(`Build:    on disk ${st.diskBuild.label}`);
  if (st.portOwner && st.state !== 'RUNNING') {
    L.push(`Port ${st.port} is held by PID ${st.portOwner.pid}${st.portOwner.name ? ` (${st.portOwner.name})` : ''}${st.portOwner.commandLine ? `: ${st.portOwner.commandLine}` : ''}`);
    if (st.healthNote) L.push(`          health check: ${st.healthNote}`);
  } else if (st.state === 'UNHEALTHY' && st.healthNote) {
    L.push(`Health:   ${st.healthNote}`);
  }
  if (st.otherProcesses && st.otherProcesses.length) {
    L.push('Other node server.js processes on this PC (not managed - check they are not stale):');
    for (const p of st.otherProcesses) L.push(`   PID ${p.pid}: ${p.commandLine}`);
  }
  if (st.action) L.push(`Next:     ${st.action}`);
  L.push(`Log:      ${st.logFile}`);
  return L;
}

module.exports = { LABELS, fmtUptime, formatStatusLines };

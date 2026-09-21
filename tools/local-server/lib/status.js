'use strict';

// Turns raw observations into ONE operator-facing state. Pure: the supervisor
// gathers the facts (PID file, OS process, health check, port table, disk build)
// and this decides what they mean, so every combination is unit-tested.
//
// States:
//   STOPPED        nothing running, port free
//   RUNNING        started by the launcher, answering health, current build
//   STALE_BUILD    answering health, but running older code than the files on disk
//   UNHEALTHY      launcher-started process is alive but not answering health
//   UNMANAGED      a Foxy server is answering on the port but was not started by
//                  the launcher (or a different PID than recorded)
//   PORT_CONFLICT  the port is held by something that is not a healthy Foxy server
//                  (an older Foxy without /api/health, or another program)
//
// input: {
//   record:       PID file contents or null,
//   processInfo:  OS view of record.pid ({pid,name,commandLine}) or null,
//   identityOk:   result of canTerminateManaged(...).ok for that record,
//   health:       parsed /api/health, or null if unreachable / not Foxy,
//   portOwner:    { pid } | null  (who is LISTENING on the port),
//   diskFingerprint: fingerprint of the server-side files on disk now, or null
// }
const { fingerprintsMatch } = require('../../../buildInfo');

function classifyStatus(input) {
  const { record, processInfo, identityOk, health, portOwner, diskFingerprint } = input;
  const out = { state: 'STOPPED', headline: 'Server is stopped', detail: '', action: 'Start it with the launcher.', stalePidFile: false, stale: false, managed: false };

  const recordAlive = !!(record && processInfo);
  if (record && !processInfo) out.stalePidFile = true;

  const healthy = !!(health && health.ok && health.app === 'foxy-presentation-timer');

  if (healthy) {
    const pidMatches = !!(record && Number.isInteger(health.pid) && health.pid === record.pid);
    out.managed = pidMatches && identityOk === true;
    const runningFp = health.build && health.build.fingerprint;
    const disk = diskFingerprint || health.diskFingerprint;
    out.stale = health.stale === true || (!!disk && !fingerprintsMatch(runningFp, disk));

    if (!out.managed) {
      out.state = 'UNMANAGED';
      out.headline = `A Foxy server is running (PID ${health.pid}) but was not started by this launcher`;
      out.detail = record && recordAlive && !pidMatches
        ? `The PID file says ${record.pid}; the server on the port is ${health.pid}.`
        : 'It may have been started by hand (npm start / node server.js). The launcher will not manage it silently.';
      out.action = 'Stop the other server (or use "Stop unmanaged server" after checking it), then Start from the launcher.';
      return out;
    }
    if (out.stale) {
      out.state = 'STALE_BUILD';
      out.headline = 'Server is running OLDER CODE than the files on disk';
      out.detail = `Running build ${runningFp}; files on disk ${disk}. Browsers get the new pages but the server behaves like the old build.`;
      out.action = 'Restart the server.';
      return out;
    }
    out.state = 'RUNNING';
    out.headline = 'Server is running and healthy';
    out.detail = '';
    out.action = '';
    return out;
  }

  // Not answering health.
  if (record && recordAlive && identityOk) {
    out.managed = true;
    out.state = 'UNHEALTHY';
    out.headline = `Server process (PID ${record.pid}) is alive but not answering health checks`;
    out.detail = 'It may still be starting, be hung, or have lost its port.';
    out.action = 'Restart the server; check the log if it persists.';
    return out;
  }
  if (portOwner) {
    out.state = 'PORT_CONFLICT';
    out.headline = `Port is in use by another process (PID ${portOwner.pid}) that is not a healthy Foxy server`;
    out.detail = 'This can be an OLDER Foxy server (before health reporting existed) or an unrelated program. The launcher will not stop it automatically.';
    out.action = 'Check the process below; use "Stop unmanaged server" only if it is an old Foxy server, or pick another port.';
    return out;
  }
  if (out.stalePidFile) {
    out.detail = `A leftover PID file (PID ${record.pid}) pointed at a process that no longer exists; it is ignored.`;
  }
  return out;
}

module.exports = { classifyStatus };

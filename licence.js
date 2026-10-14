'use strict';

// Foxy Timer for Windows: the show laptop's side of the trial (see trials.js
// for the Online side).
//
// Whether this run is "full" or "limited" is decided once, at startup, from
// the licence stored in meta - so nothing ever changes under a running show.
// The one exception is an upgrade: if a check-in with Foxy Timer Online brings
// back a valid licence (first launch, or an admin extended the trial), full
// mode switches on straight away. A run never drops to limited mid-show.
//
// Limited mode = one room, and a small "Foxy Timer" mark on displays. Used
// when the trial has ended, when no trial could be started yet (never been
// online), or when the PC clock has been wound back past the last time seen.

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const trials = require('./trials');

const LICENCE_META = 'windows_licence';
const MACHINE_META = 'windows_machine_id';
const CLOCK_META = 'windows_licence_clock';
const CLOCK_TOLERANCE_MS = 2 * 60 * 60 * 1000; // DST changes, small clock fixes
const CHECK_IN_TIMEOUT_MS = 8000;
const DEFAULT_ONLINE_URL = 'https://foxytimer.com';

// Windows' own install id, hashed so the raw value never leaves the laptop.
// Survives reinstalling Foxy Timer and deleting its data folder.
function windowsMachineGuid() {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const m = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function createLicenceManager({
  getMeta,
  setMeta,
  fetchImpl = globalThis.fetch,
  publicKey = trials.LICENCE_PUBLIC_KEY,
  onlineUrl = process.env.FOXY_ONLINE_URL || DEFAULT_ONLINE_URL,
  appVersion = null,
  machineGuid = windowsMachineGuid,
  now = Date.now,
  onChange = () => {}
}) {
  function machineId() {
    let id = getMeta(MACHINE_META);
    if (id) return id;
    const guid = machineGuid();
    id = guid
      ? crypto.createHash('sha256').update(`foxy-timer|${guid}`).digest('hex')
      : crypto.randomBytes(32).toString('hex');
    setMeta(MACHINE_META, id);
    return id;
  }

  const machine = machineId();

  // Highest time this laptop has seen. A clock behind it by more than the
  // tolerance means someone wound it back to stretch the trial.
  function clockWoundBack() {
    const high = Number(getMeta(CLOCK_META)) || 0;
    const t = now();
    if (t > high) setMeta(CLOCK_META, String(t));
    return high - t > CLOCK_TOLERANCE_MS;
  }

  function evaluate() {
    const stored = getMeta(LICENCE_META);
    if (!stored) return { status: 'none' };
    if (clockWoundBack()) return { status: 'clock' };
    return trials.licenceStatus(stored, machine, now(), publicKey);
  }

  let state = evaluate();
  let limited = state.status !== 'active';
  let lastCheckIn = null; // { at, ok, error }

  function info() {
    return {
      status: state.status,
      daysLeft: state.daysLeft || null,
      expiresAt: state.expiresAt || null,
      limited,
      onlineUrl,
      lastCheckIn
    };
  }

  // Ask Online for this machine's licence. Never throws; offline is normal.
  async function checkIn() {
    try {
      const res = await fetchImpl(`${onlineUrl}/api/windows/trial`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machineId: machine, appVersion }),
        signal: AbortSignal.timeout(CHECK_IN_TIMEOUT_MS)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        lastCheckIn = { at: now(), ok: false, error: data.error || `HTTP ${res.status}` };
        return info();
      }
      if (!trials.verifyLicence(data.licence, machine, publicKey)) {
        lastCheckIn = { at: now(), ok: false, error: 'Licence did not verify' };
        return info();
      }
      setMeta(LICENCE_META, data.licence);
      lastCheckIn = { at: now(), ok: true };
      const fresh = evaluate();
      // Upgrade at once; a downgrade waits for the next start.
      if (fresh.status === 'active') {
        const wasLimited = limited;
        state = fresh;
        limited = false;
        if (wasLimited) onChange(info());
      } else if (limited) {
        state = fresh;
      }
    } catch (err) {
      lastCheckIn = { at: now(), ok: false, error: err.name === 'TimeoutError' ? 'No reply' : 'Offline' };
    }
    return info();
  }

  return {
    machineId: machine,
    info,
    isLimited: () => limited,
    checkIn,
    tickClock: clockWoundBack
  };
}

module.exports = { createLicenceManager, windowsMachineGuid, CLOCK_TOLERANCE_MS };

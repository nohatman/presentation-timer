'use strict';

// In-memory, ephemeral registry for Physical Display Output (CDEther) bridge
// status (P2.1). Never persisted to SQLite — a server restart must not
// resurrect a stale "Live" claim; every room starts with no known status
// until a bridge reports again.
//
// Room identity is NEVER read from the payload here — every public function
// takes `roomId` as an explicit argument supplied by the caller (server.js),
// which derives it once at socket-connection time from the authenticated
// token (see auth.resolveSocketAccess). This module has no way to attribute
// a report to any room other than the one its caller names, so cross-room
// spoofing is structurally impossible, not just disallowed by convention.
//
// Entries are keyed by the server-assigned Socket.IO `socket.id`, never by
// anything the bridge claims about itself (its `bridgeId` field is a
// correlation label only, for logs/support — never used for identity or
// authorization). This is also how multiple simultaneous bridges for one
// room are represented: each gets its own entry, not silently overwritten.
//
// See tools/cdether-bridge/P2-PLAN.md for the full design.

const OVERALL_STATES = new Set(['off', 'connecting', 'live', 'degraded', 'error']);
const OUTPUT_STATES = new Set(['stopped', 'running', 'send-error']);

const STALE_MS = 20000; // 2x the bridge's 10s heartbeat interval, plus margin
const SWEEP_INTERVAL_MS = 5000;
const MAX_EVENTS_PER_SECOND = 2;

const BRIDGE_ID_RE = /^[0-9a-f]{1,32}$/i;

function isStringOrNullish(v, maxLen) {
  return v === undefined || v === null || (typeof v === 'string' && v.length <= maxLen);
}

function sanitizeText(v) {
  let out = '';
  for (let i = 0; i < v.length; i++) {
    const code = v.charCodeAt(i);
    if (code > 31 && code !== 127) out += v[i];
  }
  return out;
}

// Validates and whitelists a raw `bridgeStatus` event payload. Returns a
// frozen, sanitized object on success, or null if the payload should be
// dropped. Any field not explicitly listed here is discarded, not copied
// through — this is a whitelist, not a filter.
function validatePayload(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.v !== 1) return null;
  if (!OVERALL_STATES.has(raw.overall)) return null;
  if (!OUTPUT_STATES.has(raw.output)) return null;
  if (typeof raw.ptConnected !== 'boolean') return null;
  if (raw.bridgeId !== undefined && raw.bridgeId !== null) {
    if (typeof raw.bridgeId !== 'string' || !BRIDGE_ID_RE.test(raw.bridgeId)) return null;
  }
  if (!isStringOrNullish(raw.bridgeVersion, 32)) return null;
  if (!isStringOrNullish(raw.interfaceName, 64)) return null;
  if (!isStringOrNullish(raw.reason, 160)) return null;

  return Object.freeze({
    v: 1,
    bridgeId: raw.bridgeId ? sanitizeText(raw.bridgeId) : null,
    bridgeVersion: raw.bridgeVersion ? sanitizeText(raw.bridgeVersion) : null,
    overall: raw.overall,
    reason: raw.reason ? sanitizeText(raw.reason) : null,
    output: raw.output,
    ptConnected: raw.ptConnected,
    interfaceName: raw.interfaceName ? sanitizeText(raw.interfaceName) : null,
  });
}

function describeMultiple(count) {
  return `${count} Physical Display Output sources reporting for this room — stop one to avoid conflicting output`;
}

function describeOff() {
  return 'Physical Display Output is not currently connected for this room';
}

/**
 * Creates an isolated registry instance. A fresh instance is used per
 * process (server.js) or per test — never a hidden module-level singleton —
 * so tests can run in parallel without shared state.
 */
function createBridgeStatusRegistry() {
  const byRoom = new Map();   // roomId -> Map<socketId, { payload, receivedAt }>
  const everSeen = new Set(); // roomId -> has this room ever had a valid report
  const rateState = new Map(); // socketId -> { windowStart, count }

  function allowRate(socketId, now) {
    const state = rateState.get(socketId);
    if (!state || now - state.windowStart >= 1000) {
      rateState.set(socketId, { windowStart: now, count: 1 });
      return true;
    }
    if (state.count >= MAX_EVENTS_PER_SECOND) return false;
    state.count += 1;
    return true;
  }

  /** Record one heartbeat. Returns { accepted, reason } — never throws. */
  function record(roomId, socketId, rawPayload) {
    const now = Date.now();
    if (!allowRate(socketId, now)) return { accepted: false, reason: 'rate-limited' };
    const payload = validatePayload(rawPayload);
    if (!payload) return { accepted: false, reason: 'invalid-payload' };

    let room = byRoom.get(roomId);
    if (!room) {
      room = new Map();
      byRoom.set(roomId, room);
    }
    room.set(socketId, { payload, receivedAt: now });
    everSeen.add(roomId);
    return { accepted: true };
  }

  /** Remove one socket's entry immediately (called on socket disconnect). */
  function clear(roomId, socketId) {
    rateState.delete(socketId);
    const room = byRoom.get(roomId);
    if (!room) return false;
    const had = room.delete(socketId);
    if (room.size === 0) byRoom.delete(roomId);
    return had;
  }

  /**
   * The sanitized, public per-room snapshot the Control page renders.
   * Returns null only if this room has never had any bridge report at all
   * (so a room with no Physical Display Output configured shows no pill).
   * Once a room has ever reported, this always returns a real object —
   * including an honest "off" object once every active entry is gone.
   */
  function effectiveStatus(roomId) {
    if (!everSeen.has(roomId)) return null;
    const room = byRoom.get(roomId);
    if (!room || room.size === 0) {
      return { overall: 'off', reason: describeOff(), output: null, interfaceName: null, bridgeVersion: null, sources: 0 };
    }
    const entries = [...room.values()];
    if (entries.length === 1) {
      const p = entries[0].payload;
      return { overall: p.overall, reason: p.reason, output: p.output, interfaceName: p.interfaceName, bridgeVersion: p.bridgeVersion, sources: 1 };
    }
    // Multiple simultaneous bridges for one room: surfaced honestly as a
    // distinct degraded condition, not silently resolved to "whichever sent
    // last" — CDEther has no arbitration, so two live senders is itself an
    // unhealthy state regardless of each sender's own reported health.
    return {
      overall: 'degraded',
      reason: describeMultiple(entries.length),
      output: null,
      interfaceName: null,
      bridgeVersion: null,
      sources: entries.length,
    };
  }

  /** Drops entries older than STALE_MS. Returns the list of roomIds that changed. */
  function sweepStale(now = Date.now()) {
    const changedRoomIds = [];
    for (const [roomId, room] of byRoom) {
      let changed = false;
      for (const [socketId, entry] of room) {
        if (now - entry.receivedAt > STALE_MS) {
          room.delete(socketId);
          changed = true;
        }
      }
      if (room.size === 0) byRoom.delete(roomId);
      if (changed) changedRoomIds.push(roomId);
    }
    return changedRoomIds;
  }

  /** Wires sweepStale() to a real timer, unref'd so it never blocks process exit. */
  function startSweep(onChange, intervalMs = SWEEP_INTERVAL_MS) {
    const timer = setInterval(() => {
      for (const roomId of sweepStale()) onChange(roomId, effectiveStatus(roomId));
    }, intervalMs);
    if (timer.unref) timer.unref();
    return timer;
  }

  return { record, clear, effectiveStatus, sweepStale, startSweep };
}

module.exports = {
  createBridgeStatusRegistry,
  validatePayload,
  OVERALL_STATES,
  OUTPUT_STATES,
  STALE_MS,
  SWEEP_INTERVAL_MS,
  MAX_EVENTS_PER_SECOND,
};

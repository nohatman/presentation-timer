const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const db = require('./db');
const auth = require('./auth');
const { buildRoomLinks } = require('./urls');
const bridgeStatus = require('./bridgeStatus');
const timerModes = require('./timerModes');
const { sanitizeDeviceName, sanitizePanelId } = require('./deviceNames');
const enquiries = require('./enquiries');
const demoRooms = require('./demoRooms');
const QRCode = require('qrcode');
const crypto = require('crypto');
const buildInfo = require('./buildInfo');

const app = express();
app.set('trust proxy', true); // needed behind Railway's proxy so req.protocol is https, not http

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Enable CORS for all routes
app.use(cors());
app.use(express.json());

// Serve static files with cache-control (avoid stale HTML after deploy)
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store');
    } else {
      // cache other assets briefly
      res.setHeader('Cache-Control', 'public, max-age=300');
    }
  }
}));

// Timer state - keyed by the room's database id (as a string), NEVER by the
// operator-chosen slug. Slugs are only unique within one client's rooms, so they
// are not safe as a cross-client lookup key - see db.js for details.
const timerRooms = new Map();

// Phase 4: which control-token socket is the "active controller" for a room
// (Map<roomId, socketId>). In-memory/ephemeral only - a live-session concept,
// not persisted, and reset on server restart (the next control connection just
// claims the slot fresh). This governs browser control-token sessions only -
// REST/dashboard/Companion actions authenticate via client API key, a separate,
// higher trust tier, and are deliberately exempt from this entirely.
const roomControllers = new Map();

// Control belongs to a PANEL (a Control page tab, identified by the panelId it
// keeps in sessionStorage), not to one socket connection. A controller's
// connection routinely drops and comes back - a page refresh, a phone locking
// or backgrounding the tab, a Wi-Fi/4G hand-over - and each of those used to
// hand control straight to another connected panel, so the operator who had
// just taken control found themselves an observer again. Now:
//  * roomControllerPanels remembers which panel holds the seat (and its name);
//  * when the controlling socket disconnects, the seat is RESERVED for that
//    panel for CONTROLLER_GRACE_MS - if it reconnects (same panelId) it simply
//    gets it back; other panels see "<name> is disconnected" meanwhile;
//  * only if it doesn't return in time does the previous behaviour happen
//    (promote another connected control panel, else leave the seat empty).
// "Same panel" = same tab (panelId) or same browser/device (deviceId,
// localStorage). Control follows the operator's NEWEST tab on the controlling
// device: opening the Control page again on that device (a new tab, or back
// from the Master Dashboard) takes the seat from the older tab straight away -
// it's the same person - and if the controlling tab closes while another tab
// on that device is still open, control moves to that tab immediately.
// Take Over stays available to every panel throughout - nobody is ever locked
// out waiting for a reservation to expire. A page that sends no panelId can't
// be recognised on return, so it keeps the old immediate hand-over.
// 30 min, not seconds: a phone that's locked or pocketed through a whole talk
// should still wake up as the controller. Holding the seat that long costs
// nothing, since every other panel can Take Over with one tap at any moment.
const CONTROLLER_GRACE_MS = Number(process.env.CONTROLLER_GRACE_MS) || 30 * 60 * 1000;
const roomControllerPanels = new Map(); // roomId -> { panelId, deviceId, name }
const controllerGraceTimers = new Map(); // roomId -> timeout, only while a reservation is pending

function clearControllerGrace(roomId) {
  const t = controllerGraceTimers.get(roomId);
  if (t) clearTimeout(t);
  controllerGraceTimers.delete(roomId);
}

function setRoomController(roomId, socket) {
  clearControllerGrace(roomId);
  roomControllers.set(roomId, socket.id);
  roomControllerPanels.set(roomId, { panelId: socket.panelId, deviceId: socket.deviceId, name: socket.deviceName });
}

// Room deleted/cleaned up: drop everything, including a pending reservation.
function forgetRoomController(roomId) {
  clearControllerGrace(roomId);
  roomControllers.delete(roomId);
  roomControllerPanels.delete(roomId);
}

// Previous behaviour: first other connected control panel in the room, if any.
function promoteAnotherController(roomId, excludeSocketId) {
  const socketsInRoom = io.sockets.adapter.rooms.get(roomId);
  for (const socketId of socketsInRoom || []) {
    if (socketId === excludeSocketId) continue;
    const other = io.sockets.sockets.get(socketId);
    if (other && other.clientType === 'control') { setRoomController(roomId, other); return; }
  }
  roomControllers.delete(roomId);
  roomControllerPanels.delete(roomId);
}

// Physical Display Output (CDEther) compact status — P2.1. In-memory only,
// fed by a narrowly-scoped `bridgeStatus` event from display-role sockets
// riding their existing read-only connection (see the handler inside
// io.on('connection', ...) below). Every entry's room identity always comes
// from that connection's own server-resolved roomId, never from anything in
// the event payload — cross-room spoofing is structurally impossible here,
// not just disallowed by convention. Never persisted: a server restart must
// not resurrect a stale "Live" claim. See tools/cdether-bridge/P2-PLAN.md.
const bridgeStatusRegistry = bridgeStatus.createBridgeStatusRegistry();
bridgeStatusRegistry.startSweep((roomId, status) => {
  io.to(roomId).emit('bridgeStatusUpdate', status);
});

// activeControllerName: the controller panel's self-chosen device name (see
// deviceNames.js - a label, not identity), or null if it never sent one.
// reconnecting: the seat is reserved for a controller whose connection just
// dropped (activeControllerSocketId is null meanwhile).
// controllerOnThisDevice: the controller is another tab of the RECIPIENT's own
// device (so its page can say "moved to another tab on this device" rather than
// "<its own name> took control"). Computed per recipient, so no device id is
// ever sent to anyone. All three are additive fields.
function controllerStatusPayload(roomId, recipient) {
  const activeId = roomControllers.get(roomId) || null;
  const active = activeId && io.sockets.sockets.get(activeId);
  const reconnecting = !activeId && controllerGraceTimers.has(roomId);
  const reserved = roomControllerPanels.get(roomId);
  const holderDeviceId = active ? active.deviceId : (reserved && reserved.deviceId);
  return {
    activeControllerSocketId: activeId,
    activeControllerName: (active && active.deviceName) || (reconnecting && reserved && reserved.name) || null,
    reconnecting,
    controllerOnThisDevice: !!(recipient && recipient.deviceId && holderDeviceId === recipient.deviceId && activeId !== recipient.id),
  };
}

function broadcastControllerStatus(roomId) {
  for (const socketId of io.sockets.adapter.rooms.get(roomId) || []) {
    const recipient = io.sockets.sockets.get(socketId);
    if (recipient) recipient.emit('controllerStatus', controllerStatusPayload(roomId, recipient));
  }
}

// Another connected control socket of the same panel/device as `socket`, if any.
function findSiblingTab(roomId, socket) {
  for (const socketId of io.sockets.adapter.rooms.get(roomId) || []) {
    if (socketId === socket.id) continue;
    const other = io.sockets.sockets.get(socketId);
    if (other && other.clientType === 'control' &&
        ((socket.deviceId && other.deviceId === socket.deviceId) || (socket.panelId && other.panelId === socket.panelId))) {
      return other;
    }
  }
  return null;
}

// ============================================
// Persistence - save/load room state via SQLite (db.js)
//
// The in-memory Map below remains the live source of truth for the running
// timer engine; this is purely load-at-boot / save-on-change persistence,
// same debounce as before. See db.js for storage details.
// ============================================

let saveTimeout = null;

function scheduleSave() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(persistRooms, 500);
}

function persistRooms() {
  try {
    db.saveRoomStates(timerRooms);
  } catch (err) {
    console.error('⚠️  Failed to save rooms state:', err.message);
  }
}

function loadRooms() {
  try {
    const loaded = db.loadAllRoomStates();
    let count = 0;
    for (const [roomId, state] of loaded.entries()) {
      // Merge with defaults so any new fields added later are present
      timerRooms.set(roomId, timerModes.normalizeState({ ...createDefaultTimerState(), ...state }));
      count++;
    }
    if (count > 0) console.log(`✅ Loaded ${count} room(s) from database`);
  } catch (err) {
    console.error('⚠️  Failed to load rooms state (starting fresh):', err.message);
  }
}

// ============================================

// Loose guard for display-appearance color fields from updateSettings - rejects
// anything that isn't a plain #rrggbb (or #rgb) string rather than trusting an
// arbitrary client value straight into state that gets broadcast/persisted.
function isHexColor(v) {
  return typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v);
}

function createDefaultTimerState() {
  return {
    mode: 'stopped', // 'stopped', 'running', 'paused'
    durationMs: 30 * 60 * 1000, // 30 minutes default
    startTime: null,
    pauseTime: null,
    accumulatedPauseMs: 0,
    speed: 1.0,
    amberThresholdMs: 5 * 60 * 1000, // 5 minutes
    redThresholdMs: 2 * 60 * 1000, // 2 minutes
    endAtTarget: null,
    timerMode: 'duration', // 'duration' | 'endAt' - see timerModes.js
    configDurationMs: 30 * 60 * 1000, // operator's Duration-mode value (survives End at)
    endAtTzOffsetMin: null, // operator's Date#getTimezoneOffset() for endAtTarget
    runEndAtMs: null, // absolute finish of a running End-at run (see timerModes.js)
    countUp: false,
    showClock: false,
    outputMode: 'timer', // 'timer' | 'clock'
    displayScale: 1.5, // Display size multiplier (0.5 - 2.0)
    // Display appearance - lets an operator brand/chromakey a shared display
    // link without touching the main timer controls. Hex colors; visibility
    // toggles default true so existing rooms behave exactly as before.
    timerColorNormal: '#4caf50',
    timerColorAmber: '#ffb300',
    timerColorRed: '#f44336',
    displayBgColor: '#000000',
    showSpeakerName: true,
    showUpNext: true,
    rundown: [],       // [{name, durationMs}] programme list
    rundownIndex: -1,  // -1 = not in rundown mode
    message: '',
    messageMode: 'none', // 'none' | 'overlay' | 'ticker'
    messageTickerSpeed: 1.0 // multiplier: 0.5=slow, 1.0=normal, 2.0=fast
  };
}

// Rooms are never created implicitly anymore - only via POST /api/rooms (authenticated)
// or at boot from the database. This just reads whatever's already there.
function getRoomState(roomId) {
  return timerRooms.get(roomId);
}

// Emit timer state to a room, always including the server's current timestamp so
// clients can correct for clock skew when computing elapsed time.
function emitState(roomId, timerState) {
  io.to(roomId).emit('timerState', { ...timerState, serverNow: Date.now() });
}

// Express middleware (chained after auth.resolveOwnedRoom) - attaches the live
// in-memory state for req.roomId. A miss here means the DB and the in-memory Map
// have gone out of sync, which should never happen; treated as a hard error rather
// than silently recreating a room.
function attachTimerState(req, res, next) {
  const timerState = timerRooms.get(req.roomId);
  if (!timerState) {
    return res.status(500).json({ ok: false, error: 'Room exists in database but not in memory' });
  }
  req.timerState = timerState;
  next();
}

// Socket.IO connection handling - identity comes ONLY from a server-issued token
// (control or display), resolved against the database. Nothing client-declared
// (room name, "type" param) is ever trusted.
io.on('connection', (socket) => {
  const token = (socket.handshake.auth && socket.handshake.auth.token) || socket.handshake.query.token;
  const access = auth.resolveSocketAccess(token);

  if (!access) {
    socket.emit('authError', { message: 'Invalid or expired link. Ask the room owner for a fresh control/display link.' });
    socket.disconnect(true);
    return;
  }

  const { roomId, role } = access; // role: 'control' | 'display', derived server-side
  socket.join(roomId);
  if (access.room.expires_at) socket.emit('demoInfo', { expiresAt: access.room.expires_at });
  socket.clientType = role;
  socket.roomId = roomId;
  // Control panels introduce themselves with a device name (display sockets
  // have no use for one). Sanitised; null if missing/blank.
  socket.deviceName = role === 'control' ? sanitizeDeviceName(socket.handshake.auth && socket.handshake.auth.deviceName) : null;
  socket.panelId = role === 'control' ? sanitizePanelId(socket.handshake.auth && socket.handshake.auth.panelId) : null;
  socket.deviceId = role === 'control' ? sanitizePanelId(socket.handshake.auth && socket.handshake.auth.deviceId) : null;

  console.log(`👤 Client ${socket.id} joined room: ${roomId} as ${role}`);

  // Send current state to new client, plus a one-time roomInfo. Every role gets
  // the slug (just a label, not a secret). Only control-role sockets also get
  // both links - a control token grants no way to learn the room's separate
  // display token other than the server telling it. This must NEVER go out via
  // the shared emitState() broadcast (io.to(roomId)), since that reaches
  // display-role sockets too, who must never see the control link.
  const initialState = getRoomState(roomId);
  // A stopped End at timer's time-to-target is a snapshot; refresh it so a
  // freshly-loaded control/display never shows a stale value.
  if (initialState) timerModes.syncStoppedDuration(initialState, Date.now());
  let roomInfo = { slug: access.room.slug };
  if (role === 'control') {
    const proto = socket.handshake.headers['x-forwarded-proto'] || (socket.handshake.secure ? 'https' : 'http');
    const baseUrl = `${proto}://${socket.handshake.headers.host}`;
    roomInfo = { ...roomInfo, ...buildRoomLinks(baseUrl, access.room) };
  }
  socket.emit('timerState', { ...initialState, serverNow: Date.now(), ...(roomInfo ? { roomInfo } : {}) });

  // A freshly-connected control-role socket should see current Physical
  // Display Output status immediately (e.g. the Control page was opened or
  // reloaded after the bridge was already running), not wait for the next
  // heartbeat or a change to occur. Sent directly to this one socket, not
  // broadcast - every subsequent update uses the same 'bridgeStatusUpdate'
  // event via a room broadcast, so the client only needs one listener.
  if (role === 'control') {
    const currentPdoStatus = bridgeStatusRegistry.effectiveStatus(roomId);
    if (currentPdoStatus) socket.emit('bridgeStatusUpdate', currentPdoStatus);
  }

  // Broadcast controller count to all clients in room
  broadcastControllerCount(roomId);

  // Phase 4: claim active-controller status if this is the controlling panel
  // coming back (same panelId - its seat is kept for it, see CONTROLLER_GRACE_MS),
  // or if the seat is free: no connected holder and no reservation pending.
  // Otherwise this socket is an observer - it gets told the current status
  // directly rather than triggering a room-wide broadcast, since nothing changed
  // for the sockets already connected.
  if (role === 'control') {
    const currentHolder = roomControllers.get(roomId);
    const holderStillConnected = currentHolder && io.sockets.sockets.get(currentHolder);
    const reserved = roomControllerPanels.get(roomId);
    const isReturningController = !!reserved && (
      (!!socket.panelId && reserved.panelId === socket.panelId) ||
      (!!socket.deviceId && reserved.deviceId === socket.deviceId));
    if (isReturningController || (!holderStillConnected && !controllerGraceTimers.has(roomId))) {
      setRoomController(roomId, socket);
      broadcastControllerStatus(roomId);
    } else {
      socket.emit('controllerStatus', controllerStatusPayload(roomId, socket));
    }
  }

  // Display-role sockets may only ever read. Control-role sockets that aren't the
  // current active controller (observers) are rejected too, with a reason sent
  // back so their UI can explain why nothing happened - every mutation handler
  // below uses this instead of a bare role check.
  function requireActiveController() {
    if (socket.clientType !== 'control') return false;
    if (roomControllers.get(roomId) !== socket.id) {
      socket.emit('controlRejected', { message: 'You are in observer mode - another operator is currently in control. Use Take Over to gain control.' });
      return false;
    }
    return true;
  }

  // Any control-token holder can take over at any time - no approval step, no
  // hard lock. A stuck/disconnected "active controller" must never be able to
  // block a legitimate operator during a live event.
  socket.on('requestControl', () => {
    if (socket.clientType !== 'control') return;
    setRoomController(roomId, socket); // also cancels any reservation for a reconnecting controller
    broadcastControllerStatus(roomId);
  });

  // Rename this panel. Allowed for observers too - it's a label for this
  // device, not a room/timer change. Blank/invalid names are ignored.
  socket.on('setDeviceName', (value) => {
    if (socket.clientType !== 'control') return;
    const name = sanitizeDeviceName(value);
    if (!name || name === socket.deviceName) return;
    socket.deviceName = name;
    if (roomControllers.get(roomId) === socket.id) {
      roomControllerPanels.set(roomId, { panelId: socket.panelId, deviceId: socket.deviceId, name });
      broadcastControllerStatus(roomId);
    }
    broadcastControllerCount(roomId);
  });

  // Handle control commands from control panel
  socket.on('startTimer', (data) => {
    if (!requireActiveController()) return;
    const timerState = getRoomState(roomId);
    if (!timerState) return;
    data = data || {};
    // Mode/duration/end-at handling (incl. computing the End at run length from
    // the server clock + operator timezone) lives in timerModes.js.
    timerModes.startTimer(timerState, data, Date.now());
    if (data.speed !== undefined) timerState.speed = data.speed;
    if (data.amberThresholdMs !== undefined) timerState.amberThresholdMs = data.amberThresholdMs;
    if (data.redThresholdMs !== undefined) timerState.redThresholdMs = data.redThresholdMs;
    if (data.countUp !== undefined) timerState.countUp = data.countUp;
    if (data.showClock !== undefined) timerState.showClock = data.showClock;

    emitState(roomId, timerState);
    scheduleSave();
  });

  // Explicit output mode control (overrides showClock convenience)
  socket.on('setOutputMode', (mode) => {
    if (!requireActiveController()) return;
    const timerState = getRoomState(roomId);
    if (!timerState) return;
    if (mode === 'timer' || mode === 'clock') {
      timerState.outputMode = mode;
      // mirror to showClock for backward compatibility on clients
      timerState.showClock = (mode === 'clock');
      emitState(roomId, timerState);
      scheduleSave();
    }
  });

  // Nudge timer by deltaMs (positive to add time, negative to subtract)
  socket.on('nudgeTimer', (deltaMs) => {
    if (!requireActiveController()) return;
    const timerState = getRoomState(roomId);
    if (!timerState) return;
    if (typeof deltaMs !== 'number' || !isFinite(deltaMs)) return;
    // Running/paused: adjusts this run. Stopped: becomes the configured Duration.
    timerModes.nudge(timerState, deltaMs, Date.now());
    emitState(roomId, timerState);
    scheduleSave();
  });

  socket.on('pauseTimer', () => {
    if (!requireActiveController()) return;
    const timerState = getRoomState(roomId);
    if (!timerState) return;
    if (timerState.mode === 'running') {
      timerState.mode = 'paused';
      timerState.pauseTime = Date.now();
      emitState(roomId, timerState);
      scheduleSave();
    }
  });

  socket.on('resumeTimer', () => {
    if (!requireActiveController()) return;
    const timerState = getRoomState(roomId);
    if (!timerState) return;
    if (timerState.mode === 'paused') {
      timerModes.resumeTimer(timerState, Date.now());
      emitState(roomId, timerState);
      scheduleSave();
    }
  });

  socket.on('resetTimer', () => {
    if (!requireActiveController()) return;
    const timerState = getRoomState(roomId);
    if (!timerState) return;
    timerModes.resetTimer(timerState, Date.now());
    emitState(roomId, timerState);
    scheduleSave();
  });

  socket.on('updateSettings', (data) => {
    if (!requireActiveController()) return;
    const timerState = getRoomState(roomId);
    if (!timerState) return;
    timerModes.applyTimerConfig(timerState, data, Date.now());
    if (data.speed !== undefined) timerState.speed = data.speed;
    if (data.amberThresholdMs !== undefined) timerState.amberThresholdMs = data.amberThresholdMs;
    if (data.redThresholdMs !== undefined) timerState.redThresholdMs = data.redThresholdMs;
    if (data.countUp !== undefined) timerState.countUp = data.countUp;
    if (data.showClock !== undefined) timerState.showClock = data.showClock;
    if (data.displayScale !== undefined) timerState.displayScale = data.displayScale;
    if (isHexColor(data.timerColorNormal)) timerState.timerColorNormal = data.timerColorNormal;
    if (isHexColor(data.timerColorAmber)) timerState.timerColorAmber = data.timerColorAmber;
    if (isHexColor(data.timerColorRed)) timerState.timerColorRed = data.timerColorRed;
    if (isHexColor(data.displayBgColor)) timerState.displayBgColor = data.displayBgColor;
    if (data.showSpeakerName !== undefined) timerState.showSpeakerName = !!data.showSpeakerName;
    if (data.showUpNext !== undefined) timerState.showUpNext = !!data.showUpNext;

    emitState(roomId, timerState);
    scheduleSave();
  });

  // Payload: the items array (as always), or { items, resetIndex: true } when the
  // whole rundown is being replaced - the old "current item" then points at an
  // unrelated row, so it is cleared. The running timer itself is not touched.
  // Explicit "Set End at" from the control page (typing in the field never sends
  // anything). Applies atomically to a stopped OR live timer - see timerModes.applyEndAt.
  // The optional ack callback reports the outcome to the caller so the control page
  // can show a failure instead of silently leaving the draft "not applied": {ok:true}
  // (the authoritative state broadcast has already gone out), or {ok:false, reason}
  // with reason 'observer' | 'invalid' | 'no-room'.
  socket.on('applyEndAt', (data, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!requireActiveController()) return reply({ ok: false, reason: 'observer' });
    const timerState = getRoomState(roomId);
    if (!timerState) return reply({ ok: false, reason: 'no-room' });
    if (!timerModes.applyEndAt(timerState, data || {}, Date.now()).ok) return reply({ ok: false, reason: 'invalid' });
    emitState(roomId, timerState);
    scheduleSave();
    reply({ ok: true });
  });

  socket.on('setRundown', (payload) => {
    if (!requireActiveController()) return;
    const timerState = getRoomState(roomId);
    if (!timerState) return;
    const items = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.items) ? payload.items : null);
    if (!items) return;
    timerState.rundown = items.map(item => ({
      name: String(item.name || '').slice(0, 100),
      durationMs: Math.max(0, Math.floor(Number(item.durationMs) || 0))
    }));
    if (!Array.isArray(payload) && payload.resetIndex === true) {
      timerState.rundownIndex = -1;
    } else if (timerState.rundownIndex >= timerState.rundown.length) {
      // Clamp index if items were removed
      timerState.rundownIndex = timerState.rundown.length - 1;
    }
    emitState(roomId, timerState);
    scheduleSave();
  });

  socket.on('goToRundown', (data) => {
    if (!requireActiveController()) return;
    const timerState = getRoomState(roomId);
    if (!timerState) return;
    const index = parseInt(data.index);
    if (index < 0 || index >= timerState.rundown.length) return;
    loadRundownItem(timerState, index, !!data.autoStart);
    emitState(roomId, timerState);
    scheduleSave();
  });

  socket.on('setMessage', (data) => {
    if (!requireActiveController()) return;
    const timerState = getRoomState(roomId);
    if (!timerState) return;
    timerState.message = String(data.text || '').slice(0, 500);
    timerState.messageMode = ['none', 'overlay', 'ticker'].includes(data.mode) ? data.mode : 'none';
    if (typeof data.speed === 'number' && data.speed > 0) timerState.messageTickerSpeed = data.speed;
    emitState(roomId, timerState);
    scheduleSave();
  });

  // ---- Physical Display Output (CDEther) status reporting (P2.1) ----
  // Read-only reporting: a display-role socket may report its own bridge
  // status. This cannot mutate room state - it never touches getRoomState,
  // emitState, or any of the control-mutation handlers above. Room identity
  // is always this connection's own server-resolved `roomId` (set once at
  // connection time from the token, above) - nothing here ever reads a room
  // id from the event payload, so a report can never be attributed to a
  // different room no matter what the socket sends.
  socket.on('bridgeStatus', (payload) => {
    if (socket.clientType !== 'display') return; // structural, not just policy
    const result = bridgeStatusRegistry.record(roomId, socket.id, payload);
    if (!result.accepted) return;
    io.to(roomId).emit('bridgeStatusUpdate', bridgeStatusRegistry.effectiveStatus(roomId));
  });

  socket.on('disconnect', () => {
    console.log(`👋 Client ${socket.id} disconnected from room: ${roomId}`);

    // A departing display-role socket's Physical Display Output status is
    // cleared immediately (not left to the stale-heartbeat sweep) - an
    // intentional Stop/Quit or a crash should read as "Off" promptly.
    if (socket.clientType === 'display') {
      const hadEntry = bridgeStatusRegistry.clear(roomId, socket.id);
      if (hadEntry) {
        io.to(roomId).emit('bridgeStatusUpdate', bridgeStatusRegistry.effectiveStatus(roomId));
      }
    }

    // If the departing socket was the active controller: keep its seat reserved
    // for CONTROLLER_GRACE_MS so the same panel reconnecting (refresh, phone
    // wake, network blip) gets it straight back. Only if it doesn't return does
    // the previous behaviour apply - promote another connected control panel,
    // else leave the seat empty for the next connection. A panel that sent no
    // panelId can't be recognised on return, so it's handed over immediately.
    if (socket.clientType === 'control' && roomControllers.get(roomId) === socket.id) {
      roomControllers.delete(roomId);
      clearControllerGrace(roomId);
      const sibling = findSiblingTab(roomId, socket);
      if (sibling) {
        setRoomController(roomId, sibling); // another tab of the same device is open: same person, no wait
      } else if (socket.panelId || socket.deviceId) {
        const timer = setTimeout(() => {
          controllerGraceTimers.delete(roomId);
          if (roomControllers.get(roomId)) return; // reclaimed / taken over meanwhile
          promoteAnotherController(roomId, socket.id);
          broadcastControllerStatus(roomId);
        }, CONTROLLER_GRACE_MS);
        if (typeof timer.unref === 'function') timer.unref();
        controllerGraceTimers.set(roomId, timer);
      } else {
        promoteAnotherController(roomId, socket.id);
      }
      broadcastControllerStatus(roomId);
    }

    // Broadcast updated controller count after disconnect
    setTimeout(() => {
      broadcastControllerCount(roomId);
    }, 100);
  });
});

// Helper to broadcast controller count to room
function broadcastControllerCount(roomId) {
  const socketsInRoom = io.sockets.adapter.rooms.get(roomId);
  if (!socketsInRoom) return;

  // Counted per DEVICE, not per tab/connection: several tabs of the Control
  // page on one phone (e.g. after going to the Master Dashboard and back) are
  // one operator, not several. panels: one entry per device with the socket
  // ids of its tabs - the page matches those against its own id and the
  // controller's (which one is in control is NOT repeated here: it would go
  // stale on Take Over, when only controllerStatus is re-sent). Device ids
  // themselves are never sent.
  const byDevice = new Map();
  for (const socketId of socketsInRoom) {
    const socket = io.sockets.sockets.get(socketId);
    if (socket && socket.clientType === 'control') {
      const key = socket.deviceId || socketId;
      const entry = byDevice.get(key) || { ids: [], name: null };
      entry.ids.push(socketId);
      entry.name = socket.deviceName || entry.name;
      byDevice.set(key, entry);
    }
  }
  const panels = [...byDevice.values()];

  // Emit to all clients in room
  io.to(roomId).emit('controllerCount', { count: panels.length, panels });
}

// Rooms are only ever deleted deliberately (dashboard / admin delete, or a
// demo room reaching its expiry - see demoRooms below). There used to be an
// "empty and stopped for 30 minutes" auto-delete here, left over from when
// rooms were created implicitly by name; it silently deleted clients' rooms
// (and their links) set up ahead of a show.

// Phase 6c.3: forces every currently-connected control/display socket for a
// client's rooms to drop, at the moment of suspension - the socket-level
// equivalent of resolveSocketAccess() rejecting new connections. Disconnected
// sockets go through the normal 'disconnect' handler above (controller
// promotion, controller-count broadcast), same as regenerate-tokens/delete-room.
function disconnectAllSocketsForClient(clientId) {
  const rooms = db.getRoomsForClient(clientId);
  for (const room of rooms) {
    const roomId = String(room.id);
    const socketsInRoom = io.sockets.adapter.rooms.get(roomId);
    if (!socketsInRoom) continue;
    for (const socketId of socketsInRoom) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) socket.disconnect(true);
    }
  }
}

// Timer tick - send updates every second for all running timers
setInterval(() => {
  timerRooms.forEach((timerState, roomId) => {
    if (timerState.mode === 'running') {
      emitState(roomId, timerState);
    }
  });
}, 1000);

// ============================================
// REST API - human login (Phase 6a)
// ============================================

// Simple in-memory rate limiter for login attempts - no new dependency needed
// for something this small. Keyed by IP; `trust proxy` is already set above,
// so req.ip reflects the real client IP behind Railway's proxy, not the
// proxy's own address.
const loginAttempts = new Map(); // ip -> timestamps[]
const LOGIN_RATE_LIMIT = 8;
const LOGIN_RATE_WINDOW_MS = 5 * 60 * 1000;

function isLoginRateLimited(ip) {
  const now = Date.now();
  const attempts = (loginAttempts.get(ip) || []).filter((t) => now - t < LOGIN_RATE_WINDOW_MS);
  loginAttempts.set(ip, attempts);
  return attempts.length >= LOGIN_RATE_LIMIT;
}

function recordLoginAttempt(ip) {
  const attempts = loginAttempts.get(ip) || [];
  attempts.push(Date.now());
  loginAttempts.set(ip, attempts);
}

app.post('/api/auth/login', async (req, res) => {
  const ip = req.ip;
  if (isLoginRateLimited(ip)) {
    return res.status(429).json({ ok: false, error: 'Too many login attempts. Try again later.' });
  }

  const { email, password } = req.body || {};
  if (!email || !password) {
    recordLoginAttempt(ip);
    return res.status(401).json({ ok: false, error: 'Invalid email or password' });
  }

  // Unknown email and wrong password both fail identically - db.verifyUserPassword
  // only ever sets `reason` after the password has already checked out correct
  // (see its own comment), so this can never be used to enumerate accounts.
  const result = await db.verifyUserPassword(email, password);
  if (!result.ok) {
    recordLoginAttempt(ip);
    if (result.reason === 'account_suspended') {
      return res.status(401).json({
        ok: false,
        error: "Your organisation’s access to the app is currently paused. Your rooms and settings remain safely stored. Please contact Business Shows for assistance. Once access has been restored, you can sign in again as normal.",
        reason: 'account_suspended'
      });
    }
    return res.status(401).json({ ok: false, error: 'Invalid email or password' });
  }
  const user = result.user;

  const { rawToken, expiresAt } = db.createSession(user.id);
  auth.setSessionCookie(req, res, rawToken, expiresAt);
  res.json({ ok: true, mustChangePassword: !!user.must_change_password });
});

app.post('/api/auth/logout', (req, res) => {
  // Deliberately not gated by requireSession - the goal is "make sure I'm
  // logged out", which should succeed even against an already-expired or
  // already-invalid cookie, not itself require a valid session.
  const rawToken = auth.parseCookies(req).session;
  db.deleteSession(rawToken);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

// Requires only a bare session (auth.requireSession), NOT auth.requireDashboardAuth's
// must-change-password gate - otherwise a freshly-provisioned user could never
// reach the one endpoint that actually clears that flag.
app.post('/api/auth/change-password', auth.requireSession, async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body || {};
  if (!currentPassword || !newPassword || !confirmPassword) {
    return res.status(400).json({ ok: false, error: 'All fields are required' });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ ok: false, error: 'New password and confirmation do not match' });
  }
  if (newPassword.length < 10) {
    return res.status(400).json({ ok: false, error: 'New password must be at least 10 characters' });
  }

  const result = await db.changePassword(req.user.id, currentPassword, newPassword, req.sessionToken);
  if (!result.ok) {
    return res.status(400).json({ ok: false, error: result.error });
  }

  // changePassword() only deletes OTHER sessions, keeping this one alive by
  // token - no new cookie needed, the existing one still resolves correctly.
  res.json({ ok: true });
});

// ============================================
// REST API - client-authenticated room management (dashboard, provisioning)
// ============================================

// Shared shape for a room-list entry, used by both the normal client-scoped
// listing and the platform-admin cross-client listing below.
function summarizeRoom(row, req) {
  const roomId = String(row.id);
  const state = timerRooms.get(roomId) || createDefaultTimerState();
  const socketsInRoom = io.sockets.adapter.rooms.get(roomId);
  const connectionCount = socketsInRoom ? socketsInRoom.size : 0;

  let remainingMs = 0;
  let overMs = 0;
  if (state.mode === 'running') {
    const elapsed = (Date.now() - state.startTime - state.accumulatedPauseMs) * state.speed;
    remainingMs = Math.max(0, state.durationMs - elapsed);
    if (state.countUp) overMs = Math.max(0, elapsed - state.durationMs);
  } else if (state.mode === 'paused') {
    const elapsed = (state.pauseTime - state.startTime - state.accumulatedPauseMs) * state.speed;
    remainingMs = Math.max(0, state.durationMs - elapsed);
    if (state.countUp) overMs = Math.max(0, elapsed - state.durationMs);
  } else {
    remainingMs = state.durationMs;
  }

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const links = buildRoomLinks(baseUrl, row);

  return {
    id: roomId,
    slug: row.slug,
    clientName: row.client_name || null, // only present in the platform-admin listing
    mode: state.mode,
    connections: connectionCount,
    remainingMs: Math.floor(remainingMs),
    overMs: Math.floor(overMs),
    outputMode: state.outputMode,
    countUp: state.countUp || false,
    amberThresholdMs: state.amberThresholdMs,
    redThresholdMs: state.redThresholdMs,
    controlUrl: links.controlUrl,
    displayUrl: links.displayUrl
  };
}

// Tells the dashboard who it's talking to, so it knows whether to render the
// platform-admin (cross-client) view or the normal single-client view.
app.get('/api/whoami', auth.requireDashboardAuth, (req, res) => {
  res.json({
    ok: true,
    clientId: req.client.id,
    name: req.client.name,
    isPlatformAdmin: !!req.client.is_platform_admin
  });
});

// GET rooms: a normal client sees only its own (unchanged from Phase 2); a
// platform admin sees every room across every client, labeled with clientName.
app.get('/api/rooms', auth.requireDashboardAuth, (req, res) => {
  const rows = req.client.is_platform_admin
    ? db.getAllRoomsWithClientNames()
    : db.getRoomsForClient(req.client.id);

  res.json(rows.map((row) => summarizeRoom(row, req)));
});

// POST create a new room under the authenticated client (was: implicit on first connect)
app.post('/api/rooms', auth.requireDashboardAuth, (req, res) => {
  const { slug } = req.body || {};
  if (typeof slug !== 'string' || !slug.trim()) {
    return res.status(400).json({ ok: false, error: 'Missing or invalid "slug" in request body' });
  }
  const cleanSlug = slug.trim().slice(0, 100);

  let room;
  try {
    room = db.createRoom(req.client.id, cleanSlug);
  } catch (err) {
    return res.status(409).json({ ok: false, error: err.message });
  }

  const defaultState = createDefaultTimerState();
  timerRooms.set(String(room.id), defaultState);
  db.writeRoomState(room.id, defaultState);

  console.log(`📦 Created room "${cleanSlug}" (id=${room.id}) for client "${req.client.name}"`);

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const links = buildRoomLinks(baseUrl, room);
  res.json({ ok: true, roomId: String(room.id), slug: cleanSlug, ...links });
});

// Delete room endpoint
app.delete('/api/rooms/:roomId', auth.requireDashboardAuth, auth.resolveOwnedRoom, (req, res) => {
  const { roomId, room } = req;

  timerRooms.delete(roomId);
  forgetRoomController(roomId);
  db.deleteRoom(room.id);


  const socketsInRoom = io.sockets.adapter.rooms.get(roomId);
  if (socketsInRoom) {
    for (const socketId of socketsInRoom) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) socket.disconnect(true);
    }
  }

  console.log(`🗑️  Manually deleted room: ${room.slug} (id=${roomId})`);
  res.json({ success: true, message: 'Room deleted' });
});

// POST issue fresh control/display links for a room, invalidating the old ones.
// This is the operator-facing recovery path for "a link leaked" or "cutover broke
// my old bookmarked links" - see also scripts/list-room-links.js for a CLI version.
app.post('/api/rooms/:roomId/regenerate-tokens', auth.requireDashboardAuth, auth.resolveOwnedRoom, (req, res) => {
  const updated = db.regenerateRoomTokens(req.client.id, req.room.slug);
  if (!updated) return res.status(404).json({ ok: false, error: 'Room not found' });

  // Old links stop working immediately - disconnect anyone still using them.
  const socketsInRoom = io.sockets.adapter.rooms.get(req.roomId);
  if (socketsInRoom) {
    for (const socketId of socketsInRoom) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) socket.disconnect(true);
    }
  }

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const links = buildRoomLinks(baseUrl, updated);
  res.json({ ok: true, roomId: req.roomId, ...links });
});

// ============================================
// REST API - platform admin only (cross-client room actions)
//
// Addressed by the room's numeric id (never slug - slugs collide across clients
// by design). No ownership check: a platform admin may act on any client's room,
// which is exactly the point of the role. Every route requires
// requirePlatformAdmin, which itself requires requireClientAuth to have already
// resolved req.client - a client without the flag gets 403, unaffected otherwise.
// ============================================

const adminRoomAuth = [auth.requireDashboardAuth, auth.requirePlatformAdmin, auth.resolveRoomById, attachTimerState];

app.post('/api/admin/rooms/:id/start', ...adminRoomAuth, (req, res) => {
  const { roomId, timerState, room } = req;
  if (timerState.mode === 'running') {
    return res.json({ ok: false, error: 'Timer is already running' });
  }
  timerModes.startTimer(timerState, {}, Date.now());
  io.to(roomId).emit('timerState', timerState);
  scheduleSave();
  res.json({ ok: true, roomId, slug: room.slug, clientName: room.client_name, state: timerState });
});

app.post('/api/admin/rooms/:id/pause', ...adminRoomAuth, (req, res) => {
  const { roomId, timerState, room } = req;
  if (timerState.mode !== 'running') {
    return res.json({ ok: false, error: 'Timer is not running' });
  }
  timerState.mode = 'paused';
  timerState.pauseTime = Date.now();
  io.to(roomId).emit('timerState', timerState);
  scheduleSave();
  res.json({ ok: true, roomId, slug: room.slug, clientName: room.client_name, state: timerState });
});

app.post('/api/admin/rooms/:id/resume', ...adminRoomAuth, (req, res) => {
  const { roomId, timerState, room } = req;
  if (timerState.mode !== 'paused') {
    return res.json({ ok: false, error: 'Timer is not paused' });
  }
  timerModes.resumeTimer(timerState, Date.now());
  io.to(roomId).emit('timerState', timerState);
  scheduleSave();
  res.json({ ok: true, roomId, slug: room.slug, clientName: room.client_name, state: timerState });
});

app.post('/api/admin/rooms/:id/reset', ...adminRoomAuth, (req, res) => {
  const { roomId, timerState, room } = req;
  timerModes.resetTimer(timerState, Date.now());
  io.to(roomId).emit('timerState', timerState);
  scheduleSave();
  res.json({ ok: true, roomId, slug: room.slug, clientName: room.client_name, state: timerState });
});

app.delete('/api/admin/rooms/:id', auth.requireDashboardAuth, auth.requirePlatformAdmin, auth.resolveRoomById, (req, res) => {
  const { roomId, room } = req;

  timerRooms.delete(roomId);
  forgetRoomController(roomId);
  db.deleteRoom(room.id);


  const socketsInRoom = io.sockets.adapter.rooms.get(roomId);
  if (socketsInRoom) {
    for (const socketId of socketsInRoom) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) socket.disconnect(true);
    }
  }

  console.log(`🗑️  [platform admin] Deleted room: ${room.slug} (id=${roomId}, client=${room.client_name})`);
  res.json({ ok: true, roomId, slug: room.slug, clientName: room.client_name });
});

app.post('/api/admin/rooms/:id/regenerate-tokens', auth.requireDashboardAuth, auth.requirePlatformAdmin, auth.resolveRoomById, (req, res) => {
  const updated = db.regenerateRoomTokens(req.room.client_id, req.room.slug);
  if (!updated) return res.status(404).json({ ok: false, error: 'Room not found' });

  const socketsInRoom = io.sockets.adapter.rooms.get(req.roomId);
  if (socketsInRoom) {
    for (const socketId of socketsInRoom) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) socket.disconnect(true);
    }
  }

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const links = buildRoomLinks(baseUrl, updated);
  res.json({ ok: true, roomId: req.roomId, slug: req.room.slug, clientName: req.room.client_name, ...links });
});

// ============================================
// REST API - Platform Admin client-management UI (Phase 6c.1, read-only)
//
// requireAdminSession deliberately has no Bearer branch - a client API key,
// even a platform-admin client's own key, can never reach these endpoints,
// only a logged-in Platform Admin human session. Read-only in 6c.1: no
// create/edit/suspend/reset/rotate actions yet (Phase 6c.2/6c.3).
// ============================================

const adminClientAuth = [auth.requireAdminSession, auth.requirePlatformAdmin];

app.get('/api/admin/clients', ...adminClientAuth, (req, res) => {
  res.json({ ok: true, clients: db.getClientsWithCounts() });
});

app.get('/api/admin/clients/:id', ...adminClientAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ ok: false, error: 'Invalid client id' });
  }

  const detail = db.getClientDetail(id);
  if (!detail) {
    return res.status(404).json({ ok: false, error: 'Client not found' });
  }

  res.json({ ok: true, ...detail });
});

// ---- Phase 6c.2: mutations. Each writes exactly one audit_log entry after
// its db.js call succeeds - never before, and never including the temporary
// password or API key it may have just generated. ----

// Duplicate-name/email checks live here, not inside the db.js mutators -
// matches the existing convention already used by scripts/create-client.js
// and scripts/create-user.js (they check getClientByName/getUserByEmail
// themselves before calling the create function).

app.post('/api/admin/clients', ...adminClientAuth, (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 200);
  if (!name) {
    return res.status(400).json({ ok: false, error: 'Client name is required' });
  }
  if (db.getClientByName(name)) {
    return res.status(409).json({ ok: false, error: `A client named "${name}" already exists` });
  }

  const created = db.createClient(name);
  db.recordAuditLog({
    actorUserId: req.user.id,
    action: 'client.create',
    targetType: 'client',
    targetId: created.id,
    targetLabel: name
  });

  const client = db.getClientById(created.id);
  res.json({
    ok: true,
    client: {
      id: client.id, name: client.name, status: client.status, created_at: client.created_at,
      api_key_created_at: client.api_key_created_at, api_key_rotated_at: client.api_key_rotated_at
    },
    apiKey: created.apiKey
  });
});

app.post('/api/admin/clients/:id/rename', ...adminClientAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ ok: false, error: 'Invalid client id' });
  }
  const existing = db.getClientById(id);
  if (!existing) {
    return res.status(404).json({ ok: false, error: 'Client not found' });
  }

  const newName = String((req.body && req.body.name) || '').trim().slice(0, 200);
  if (!newName) {
    return res.status(400).json({ ok: false, error: 'Client name is required' });
  }
  const collision = db.getClientByName(newName);
  if (collision && collision.id !== id) {
    return res.status(409).json({ ok: false, error: `A client named "${newName}" already exists` });
  }

  const result = db.renameClient(id, newName);
  db.recordAuditLog({
    actorUserId: req.user.id,
    action: 'client.rename',
    targetType: 'client',
    targetId: id,
    targetLabel: `${result.oldName} → ${result.newName}`
  });

  const client = db.getClientById(id);
  res.json({ ok: true, client: { id: client.id, name: client.name, status: client.status, created_at: client.created_at } });
});

app.post('/api/admin/clients/:id/users', ...adminClientAuth, (req, res) => {
  const clientId = Number(req.params.id);
  if (!Number.isInteger(clientId)) {
    return res.status(400).json({ ok: false, error: 'Invalid client id' });
  }
  const client = db.getClientById(clientId);
  if (!client) {
    return res.status(404).json({ ok: false, error: 'Client not found' });
  }

  const email = db.normalizeEmail((req.body && req.body.email) || '');
  if (!db.isValidEmailFormat(email)) {
    return res.status(400).json({ ok: false, error: `"${(req.body && req.body.email) || ''}" doesn't look like a valid email address` });
  }
  if (db.getUserByEmail(email)) {
    return res.status(409).json({ ok: false, error: `A user with email "${email}" already exists` });
  }

  const tempPassword = db.generateTempPassword();
  const user = db.createUser(email, tempPassword, clientId, { mustChangePassword: true });
  db.recordAuditLog({
    actorUserId: req.user.id,
    action: 'user.create',
    targetType: 'user',
    targetId: user.id,
    targetLabel: email
  });

  res.json({ ok: true, user: { id: user.id, email: user.email, clientId }, tempPassword });
});

app.post('/api/admin/users/:id/reset-password', ...adminClientAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ ok: false, error: 'Invalid user id' });
  }
  const user = db.getUserById(id);
  if (!user) {
    return res.status(404).json({ ok: false, error: 'User not found' });
  }

  const result = db.resetUserPassword(user.email);
  db.recordAuditLog({
    actorUserId: req.user.id,
    action: 'user.reset_password',
    targetType: 'user',
    targetId: user.id,
    targetLabel: user.email
  });

  res.json({ ok: true, user: { id: user.id, email: user.email }, tempPassword: result.tempPassword });
});

app.post('/api/admin/users/:id/change-email', ...adminClientAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ ok: false, error: 'Invalid user id' });
  }
  const user = db.getUserById(id);
  if (!user) {
    return res.status(404).json({ ok: false, error: 'User not found' });
  }

  const newEmail = (req.body && req.body.newEmail) || '';
  const result = db.changeUserEmail(user.email, newEmail);
  if (!result.ok) {
    return res.status(400).json({ ok: false, error: result.error });
  }

  db.recordAuditLog({
    actorUserId: req.user.id,
    action: 'user.change_email',
    targetType: 'user',
    targetId: user.id,
    targetLabel: `${result.oldEmail} → ${result.newEmail}`
  });

  res.json({ ok: true, user: { id: user.id, oldEmail: result.oldEmail, newEmail: result.newEmail } });
});

// ---- Phase 6c.3: client status and API key rotation ----

app.post('/api/admin/clients/:id/suspend', ...adminClientAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ ok: false, error: 'Invalid client id' });
  }
  const existing = db.getClientById(id);
  if (!existing) {
    return res.status(404).json({ ok: false, error: 'Client not found' });
  }

  db.suspendClient(id);
  // Belt-and-braces alongside getSessionUser()'s status check: drops sockets
  // already connected at the moment of suspension, which a per-request status
  // check can't reach on its own (a socket handshake only happens once).
  disconnectAllSocketsForClient(id);

  db.recordAuditLog({
    actorUserId: req.user.id,
    action: 'client.suspend',
    targetType: 'client',
    targetId: id,
    targetLabel: existing.name
  });

  const client = db.getClientById(id);
  res.json({ ok: true, client: { id: client.id, name: client.name, status: client.status } });
});

app.post('/api/admin/clients/:id/reactivate', ...adminClientAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ ok: false, error: 'Invalid client id' });
  }
  const existing = db.getClientById(id);
  if (!existing) {
    return res.status(404).json({ ok: false, error: 'Client not found' });
  }

  db.reactivateClient(id);
  db.recordAuditLog({
    actorUserId: req.user.id,
    action: 'client.reactivate',
    targetType: 'client',
    targetId: id,
    targetLabel: existing.name
  });

  const client = db.getClientById(id);
  res.json({ ok: true, client: { id: client.id, name: client.name, status: client.status } });
});

app.post('/api/admin/clients/:id/rotate-key', ...adminClientAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ ok: false, error: 'Invalid client id' });
  }
  const existing = db.getClientById(id);
  if (!existing) {
    return res.status(404).json({ ok: false, error: 'Client not found' });
  }

  const rotated = db.rotateClientApiKeyById(id);
  db.recordAuditLog({
    actorUserId: req.user.id,
    action: 'client.rotate_api_key',
    targetType: 'client',
    targetId: id,
    targetLabel: existing.name
  });

  res.json({ ok: true, client: { id: rotated.id, name: rotated.name }, apiKey: rotated.apiKey });
});

// ============================================
// REST API for Bitfocus Companion
//
// Addressing is unchanged (roomId in the URL is still the human slug); the only
// change is that every call now requires Authorization: Bearer <clientApiKey>,
// and the slug is resolved only within that client's own rooms.
// ============================================

const roomAuth = [auth.requireDashboardAuth, auth.resolveOwnedRoom, attachTimerState];

// GET pre-computed display values optimised for Companion button feedback
app.get('/api/rooms/:roomId/companion', ...roomAuth, (req, res) => {
  const s = req.timerState;
  const roomId = req.params.roomId;

  // Compute remaining time (mirrors the display.html logic)
  let remainingMs = s.durationMs || 0;
  let isOvertime = false;

  if (s.startTime) {
    const now = Date.now();
    const elapsed = s.pauseTime
      ? ((s.pauseTime - s.startTime) - (s.accumulatedPauseMs || 0)) * (s.speed || 1.0)
      : ((now - s.startTime) - (s.accumulatedPauseMs || 0)) * (s.speed || 1.0);
    remainingMs = s.durationMs - elapsed;
    if (remainingMs < 0) {
      isOvertime = true;
      remainingMs = s.countUp ? Math.abs(remainingMs) : 0;
    }
  }

  const totalSec = Math.floor(Math.max(0, remainingMs) / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  const sign = isOvertime && s.countUp ? '-' : '';
  const timeDisplay = `${sign}${String(min).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;

  // Colour: matches display screen thresholds
  let color = 'green';
  if (s.mode === 'stopped')                          color = 'stopped';
  else if (s.mode === 'paused')                      color = 'paused';
  else if (isOvertime)                               color = 'overtime';
  else if (remainingMs <= s.redThresholdMs)          color = 'red';
  else if (remainingMs <= s.amberThresholdMs)        color = 'amber';

  const colorHex = {
    stopped: '#555555', paused: '#607d8b', green: '#4caf50',
    amber: '#ff9800', red: '#f44336', overtime: '#9c27b0'
  }[color];

  // Rundown info
  const rundown = s.rundown || [];
  const idx = s.rundownIndex;
  const speaker     = (idx >= 0 && idx < rundown.length)     ? (rundown[idx].name || '')     : '';
  const nextSpeaker = (idx >= 0 && idx + 1 < rundown.length) ? (rundown[idx+1].name || '') : '';
  const rundownPos  = (idx >= 0 && rundown.length > 0) ? `${idx+1}/${rundown.length}` : '';

  res.json({
    ok: true,
    roomId,
    // Timer
    mode:          s.mode,
    modeLabel:     s.mode.toUpperCase(),
    timeDisplay,
    isOvertime,
    remainingMs:   Math.round(remainingMs),
    // Colour feedback
    color,
    colorHex,
    amberWarning:  !isOvertime && remainingMs <= s.amberThresholdMs && s.mode === 'running',
    redWarning:    !isOvertime && remainingMs <= s.redThresholdMs   && s.mode === 'running',
    // Programme
    speaker,
    nextSpeaker,
    rundownPos,
    rundownIndex:  idx,
    rundown:       rundown.map(item => ({ name: item.name || '' })),
    // Clock mode
    outputMode:    s.outputMode
  });
});

// GET room state (read-only)
app.get('/api/rooms/:roomId/state', ...roomAuth, (req, res) => {
  res.json({
    ok: true,
    roomId: req.params.roomId,
    state: req.timerState
  });
});

// POST start timer
app.post('/api/rooms/:roomId/start', ...roomAuth, (req, res) => {
  const { roomId } = req; // internal numeric id, for io/timerRooms
  const timerState = req.timerState;

  if (timerState.mode === 'running') {
    return res.json({ ok: false, error: 'Timer is already running' });
  }

  timerModes.startTimer(timerState, {}, Date.now()); // End at rooms start with time-to-target

  io.to(roomId).emit('timerState', timerState);
  scheduleSave();

  res.json({ ok: true, roomId: req.params.roomId, state: timerState });
});

// POST pause timer
app.post('/api/rooms/:roomId/pause', ...roomAuth, (req, res) => {
  const { roomId } = req;
  const timerState = req.timerState;

  if (timerState.mode !== 'running') {
    return res.json({ ok: false, error: 'Timer is not running' });
  }

  timerState.mode = 'paused';
  timerState.pauseTime = Date.now();

  io.to(roomId).emit('timerState', timerState);
  scheduleSave();

  res.json({ ok: true, roomId: req.params.roomId, state: timerState });
});

// POST resume timer
app.post('/api/rooms/:roomId/resume', ...roomAuth, (req, res) => {
  const { roomId } = req;
  const timerState = req.timerState;

  if (timerState.mode !== 'paused') {
    return res.json({ ok: false, error: 'Timer is not paused' });
  }

  timerModes.resumeTimer(timerState, Date.now());

  io.to(roomId).emit('timerState', timerState);
  scheduleSave();

  res.json({ ok: true, roomId: req.params.roomId, state: timerState });
});

// POST reset timer
app.post('/api/rooms/:roomId/reset', ...roomAuth, (req, res) => {
  const { roomId } = req;
  const timerState = req.timerState;

  timerModes.resetTimer(timerState, Date.now());

  io.to(roomId).emit('timerState', timerState);
  scheduleSave();

  res.json({ ok: true, roomId: req.params.roomId, state: timerState });
});

// POST nudge timer (adjust time by +/- milliseconds)
app.post('/api/rooms/:roomId/nudge', ...roomAuth, (req, res) => {
  const { ms } = req.body;
  if (typeof ms !== 'number') {
    return res.json({ ok: false, error: 'Missing or invalid "ms" in request body' });
  }

  const { roomId } = req;
  const timerState = req.timerState;

  if (timerState.mode === 'running') {
    timerState.startTime -= ms;
  } else if (timerState.mode === 'paused') {
    timerState.pauseTime -= ms;
  } else {
    timerModes.nudge(timerState, ms, Date.now());
  }

  io.to(roomId).emit('timerState', timerState);
  scheduleSave();

  res.json({ ok: true, roomId: req.params.roomId, state: timerState });
});

// POST set duration (update preset duration)
app.post('/api/rooms/:roomId/set-duration', ...roomAuth, (req, res) => {
  const { durationMs } = req.body;
  if (typeof durationMs !== 'number' || durationMs < 0) {
    return res.json({ ok: false, error: 'Missing or invalid "durationMs" in request body' });
  }

  const { roomId } = req;
  const timerState = req.timerState;
  timerModes.setDuration(timerState, durationMs, Date.now());

  io.to(roomId).emit('timerState', timerState);
  scheduleSave();

  res.json({ ok: true, roomId: req.params.roomId, state: timerState });
});

// ============================================
// REST API — Rundown navigation
// ============================================

function loadRundownItem(s, index, autoStart) {
  timerModes.loadRundownItem(s, index, autoStart, Date.now());
}

// POST /api/rooms/:roomId/rundown/prev — load previous item (stops timer)
app.post('/api/rooms/:roomId/rundown/prev', ...roomAuth, (req, res) => {
  const { roomId } = req;
  const s = req.timerState;
  if (!s.rundown.length) return res.json({ ok: false, error: 'No rundown configured' });
  const idx = s.rundownIndex <= 0 ? 0 : s.rundownIndex - 1;
  if (idx === s.rundownIndex && s.rundownIndex === 0) return res.json({ ok: false, error: 'Already at first item' });
  loadRundownItem(s, idx, false);
  emitState(roomId, s);
  scheduleSave();
  res.json({ ok: true, roomId: req.params.roomId, rundownIndex: idx });
});

// POST /api/rooms/:roomId/rundown/next — load next item (stops timer)
app.post('/api/rooms/:roomId/rundown/next', ...roomAuth, (req, res) => {
  const { roomId } = req;
  const s = req.timerState;
  if (!s.rundown.length) return res.json({ ok: false, error: 'No rundown configured' });
  const idx = s.rundownIndex < 0 ? 0 : s.rundownIndex + 1;
  if (idx >= s.rundown.length) return res.json({ ok: false, error: 'Already at last item' });
  loadRundownItem(s, idx, false);
  emitState(roomId, s);
  scheduleSave();
  res.json({ ok: true, roomId: req.params.roomId, rundownIndex: idx });
});

// POST /api/rooms/:roomId/rundown/take — start the currently loaded item
// If no item is loaded (rundownIndex === -1), loads and starts the first item.
app.post('/api/rooms/:roomId/rundown/take', ...roomAuth, (req, res) => {
  const { roomId } = req;
  const s = req.timerState;
  if (!s.rundown.length) return res.json({ ok: false, error: 'No rundown configured' });
  const idx = s.rundownIndex < 0 ? 0 : s.rundownIndex;
  loadRundownItem(s, idx, true);
  emitState(roomId, s);
  scheduleSave();
  res.json({ ok: true, roomId: req.params.roomId, rundownIndex: idx });
});

// POST /api/rooms/:roomId/rundown/goto — load a specific item by 0-based index
// Body: { index: number, autoStart?: boolean }
app.post('/api/rooms/:roomId/rundown/goto', ...roomAuth, (req, res) => {
  const { index, autoStart = false } = req.body;
  if (!Number.isInteger(index)) return res.json({ ok: false, error: 'Missing or invalid "index" (0-based integer)' });
  const { roomId } = req;
  const s = req.timerState;
  if (index < 0 || index >= s.rundown.length) return res.json({ ok: false, error: `Index out of range (0–${s.rundown.length - 1})` });
  loadRundownItem(s, index, autoStart);
  emitState(roomId, s);
  scheduleSave();
  res.json({ ok: true, roomId: req.params.roomId, rundownIndex: index });
});

// POST set message on the display screen
// Body: { text: string, mode: 'none' | 'overlay' | 'ticker' }
app.post('/api/rooms/:roomId/message', ...roomAuth, (req, res) => {
  const { text = '', mode = 'none', speed } = req.body;
  if (!['none', 'overlay', 'ticker'].includes(mode)) {
    return res.json({ ok: false, error: 'mode must be "none", "overlay", or "ticker"' });
  }
  const { roomId } = req;
  const timerState = req.timerState;
  timerState.message = String(text).slice(0, 500);
  timerState.messageMode = mode;
  if (typeof speed === 'number' && speed > 0) timerState.messageTickerSpeed = speed;
  emitState(roomId, timerState);
  scheduleSave();
  res.json({ ok: true, roomId: req.params.roomId });
});

// Routes
// ============================================
// Health / build identity (used by the Local Show Server launcher and the control
// page's stale-server warning). Unauthenticated and read-only: it reports which
// build THIS process started with, and the fingerprint of the server-side files on
// disk right now - if they differ, this process is running older code than the
// files being served ("stale"). See buildInfo.js.
// ============================================
const STARTED_AT = Date.now();
const STARTED_BUILD = buildInfo.getBuildInfo(__dirname);
const LOCAL_MODE = process.env.FOXY_MODE === 'local'; // set only by the Local Show Server launcher
let diskFingerprintCache = { at: 0, value: STARTED_BUILD.fingerprint };

function currentDiskFingerprint() {
  if (Date.now() - diskFingerprintCache.at > 2000) { // cheap, but no need to hash on every poll
    diskFingerprintCache = { at: Date.now(), value: buildInfo.computeFingerprint(__dirname).fingerprint };
  }
  return diskFingerprintCache.value;
}

// ============================================
// REST API - landing-page contact form
// ============================================
// Public, so rate-limited per IP (same in-memory approach as login). A filled
// honeypot gets a normal success reply but is not stored. The email is sent
// after replying, so a slow or failing email provider never blocks or fails
// the visitor - the enquiry is already saved and listed in admin.

const contactAttempts = new Map(); // ip -> timestamps[]
const CONTACT_RATE_LIMIT = 5;
const CONTACT_RATE_WINDOW_MS = 60 * 60 * 1000;

app.post('/api/contact', (req, res) => {
  const now = Date.now();
  const recent = (contactAttempts.get(req.ip) || []).filter((t) => now - t < CONTACT_RATE_WINDOW_MS);
  if (recent.length >= CONTACT_RATE_LIMIT) {
    contactAttempts.set(req.ip, recent);
    return res.status(429).json({ ok: false, error: 'Too many messages from here. Please try again later.' });
  }
  recent.push(now);
  contactAttempts.set(req.ip, recent);

  const result = enquiries.validateEnquiry(req.body);
  if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
  if (result.spam) return res.json({ ok: true });

  const id = db.createEnquiry(result.enquiry);
  res.json({ ok: true });

  enquiries.sendNotification(result.enquiry).then((outcome) => {
    db.setEnquiryEmailStatus(id, outcome.sent ? 'sent' : outcome.reason);
    if (!outcome.sent && outcome.reason !== 'not_configured') {
      console.error(`⚠️  Enquiry #${id} saved but the email notification failed: ${outcome.reason}`);
    }
  });
});

app.get('/api/admin/enquiries', ...adminClientAuth, (req, res) => {
  res.json({ ok: true, enquiries: db.listEnquiries() });
});

app.post('/api/admin/enquiries/:id/handled', ...adminClientAuth, (req, res) => {
  const id = Number(req.params.id);
  const existing = Number.isInteger(id) ? db.getEnquiryById(id) : null;
  if (!existing) return res.status(404).json({ ok: false, error: 'Enquiry not found' });
  const handled = !(req.body && req.body.handled === false);
  db.setEnquiryHandled(id, handled);
  db.recordAuditLog({
    actorUserId: req.user.id,
    action: handled ? 'enquiry.handled' : 'enquiry.reopened',
    targetType: 'enquiry',
    targetId: id,
    targetLabel: existing.email
  });
  res.json({ ok: true, enquiry: db.getEnquiryById(id) });
});

// ============================================
// REST API - "Try it now" demo rooms (see demoRooms.js)
// ============================================

const demoConfig = demoRooms.getDemoConfig();
const demoLimiter = demoRooms.createHourlyLimiter(demoConfig.perIpPerHour);

function getDemoClientId() {
  const existing = db.getClientByName(demoRooms.DEMO_CLIENT_NAME);
  return existing ? existing.id : db.createClient(demoRooms.DEMO_CLIENT_NAME).id;
}

app.post('/api/demo', async (req, res) => {
  const clientId = getDemoClientId();
  if (db.countUnexpiredRoomsForClient(clientId) >= demoConfig.maxActive) {
    return res.status(503).json({ ok: false, error: 'The demo is very busy right now. Please try again in a few minutes.' });
  }
  if (!demoLimiter.take(req.ip)) {
    return res.status(429).json({ ok: false, error: "You've started a few demos already. Please try again later, or get in touch for a trial account." });
  }

  const expiresAt = Date.now() + demoConfig.ttlMs;
  const room = db.createRoom(clientId, `demo-${crypto.randomBytes(4).toString('hex')}`, { expiresAt });
  const state = demoRooms.seedDemoState(createDefaultTimerState(), timerModes.loadRundownItem);
  timerRooms.set(String(room.id), state);
  db.writeRoomState(room.id, state);

  const links = buildRoomLinks(`${req.protocol}://${req.get('host')}`, room);
  const qr = (text) => QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  const [controlQr, displayQr] = await Promise.all([qr(links.controlUrl), qr(links.displayUrl)]);
  console.log(`🧪 Demo room ${room.slug} (id=${room.id}) created, expires ${new Date(expiresAt).toISOString()}`);
  res.json({ ok: true, ...links, expiresAt, controlQr, displayQr });
});

// Deletes expired demo rooms. Anyone still connected is told the demo has
// ended (control/display show that instead of a generic "invalid link").
function sweepExpiredDemoRooms() {
  for (const room of db.getExpiredRooms()) {
    const roomId = String(room.id);
    for (const socketId of io.sockets.adapter.rooms.get(roomId) || []) {
      const socket = io.sockets.sockets.get(socketId);
      if (!socket) continue;
      socket.emit('authError', { reason: 'demo_ended', message: 'This demo room has ended. Thanks for trying Foxy Timer!' });
      socket.disconnect(true);
    }
    timerRooms.delete(roomId);
    forgetRoomController(roomId);
    db.deleteRoom(room.id);
    console.log(`🧪 Demo room ${room.slug} (id=${room.id}) expired and was deleted`);
  }
}

app.get('/api/health', (req, res) => {
  const diskFingerprint = currentDiskFingerprint();
  const addr = server.address();
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    app: 'foxy-presentation-timer',
    mode: LOCAL_MODE ? 'local' : 'hosted',
    pid: process.pid,
    port: addr && typeof addr === 'object' ? addr.port : null,
    startedAt: new Date(STARTED_AT).toISOString(),
    uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
    build: { commit: STARTED_BUILD.commit, dirty: STARTED_BUILD.dirty, fingerprint: STARTED_BUILD.fingerprint, label: STARTED_BUILD.label },
    diskFingerprint,
    stale: !buildInfo.fingerprintsMatch(STARTED_BUILD.fingerprint, diskFingerprint)
  });
});

// Clean stop for the launcher: flush room state, then exit. Exists ONLY when the
// launcher started this process (FOXY_MODE=local + a one-off FOXY_SHUTDOWN_TOKEN),
// only answers from the same machine, and needs the token - so it is inert on a
// hosted deployment and cannot be triggered from the LAN or by a stray request.
if (LOCAL_MODE && process.env.FOXY_SHUTDOWN_TOKEN) {
  const expected = Buffer.from(process.env.FOXY_SHUTDOWN_TOKEN);
  app.post('/api/local/shutdown', (req, res) => {
    const remote = req.socket.remoteAddress || '';
    const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    const given = Buffer.from(String(req.get('x-foxy-shutdown-token') || ''));
    const tokenOk = given.length === expected.length && crypto.timingSafeEqual(given, expected);
    if (!isLoopback || !tokenOk) return res.status(403).json({ ok: false, error: 'forbidden' });
    res.json({ ok: true, pid: process.pid });
    console.log('\n👋 Local shutdown requested by the launcher - saving state and exiting.');
    setTimeout(() => { clearTimeout(saveTimeout); persistRooms(); process.exit(0); }, 150);
  });
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/control', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'control.html'));
});

app.get('/display', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'display.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/try', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'try.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/change-password', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'change-password.html'));
});

// Phase 6c: Platform Admin client-management pages. Unlike /dashboard above
// (which serves its shell unconditionally and relies entirely on the API
// layer to gate real data), these get a server-side redirect too - deliberate
// defense-in-depth for a more sensitive, cross-tenant-data area: no session at
// all -> /login; a valid session that isn't a platform admin -> /dashboard
// (never reveals that admin pages exist, just bounces to the page they do
// have access to). The API layer (requireAdminSession + requirePlatformAdmin)
// still independently gates every byte of real data regardless of how this
// route was reached.
function requirePlatformAdminPage(req, res, next) {
  const rawToken = auth.parseCookies(req).session;
  const user = db.getSessionUser(rawToken);
  if (!user) {
    return res.redirect('/login');
  }
  const client = db.getClientById(user.client_id);
  if (!client || !client.is_platform_admin) {
    return res.redirect('/dashboard');
  }
  next();
}

app.get('/admin/clients', requirePlatformAdminPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-clients.html'));
});

app.get('/admin/clients/:id', requirePlatformAdminPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-client-detail.html'));
});

// Load persisted rooms before starting
loadRooms();
sweepExpiredDemoRooms();
setInterval(sweepExpiredDemoRooms, demoConfig.sweepMs).unref();

// Start server
const PORT = process.env.PORT || 3000;
console.log(`Starting server on port ${PORT}...`);

server.listen(PORT, () => {
  console.log(`\n✅ Presentation Timer server running successfully!`);
  console.log(`🏠 Home: http://localhost:${PORT}/`);
  console.log(`📊 Dashboard: http://localhost:${PORT}/dashboard (needs a client API key)`);
  console.log(`\n💡 Control/display links are now issued per-room via POST /api/rooms`);
  console.log(`   (see scripts/create-client.js and scripts/list-room-links.js)\n`);
});

// Handle port in use error
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Error: Port ${PORT} is already in use!`);
    console.error(`   Try one of these solutions:`);
    console.error(`   1. Stop the other application using port ${PORT}`);
    console.error(`   2. Use a different port: PORT=3001 npm start`);
    console.error(`   3. Kill the process: netstat -ano | findstr :${PORT}\n`);
    process.exit(1);
  } else {
    console.error(`\n❌ Server error:`, err);
    process.exit(1);
  }
});

// Graceful shutdown - save state before exit
function shutdown() {
  console.log(`\n\n👋 Shutting down server gracefully...`);
  persistRooms(); // synchronous final save
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

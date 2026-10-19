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
const trials = require('./trials');
const { createLicenceManager } = require('./licence');
const QRCode = require('qrcode');
const { selectLanAddresses } = require('./tools/local-server/lib/lan');
const { createRelayHub } = require('./relayHub');
const { createRelayAgent } = require('./relayAgent');
const firewall = require('./tools/local-server/lib/firewall');

// Base URL for links meant for OTHER devices. On the Local Show Server, a page
// opened on the laptop itself is on localhost, which a phone or display can't
// reach - so those links use the laptop's LAN address instead.
function shareBaseUrl(proto, host) {
  if (process.env.FOXY_MODE === 'local' && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host || '')) {
    const lan = chosenLan().primary;
    const port = (host.match(/:(\d+)$/) || [])[1];
    if (lan) return `http://${lan.address}${port ? ':' + port : ''}`;
  }
  return `${proto}://${host}`;
}
const crypto = require('crypto');
const { spawn } = require('child_process');
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
app.use((req, res, next) => { noteRemotePeer(req.socket.remoteAddress); next(); });

// Serve static files with cache-control (avoid stale HTML after deploy)
app.use(express.static(path.join(__dirname, 'public'), {
  index: false, // '/' is a route below (the Local Show Server redirects it)
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

// "Ask first" Take over (the room's takeOverAsk setting): one request at a time
// per room. The panel in control gets Allow / Refuse; no answer within
// TAKE_OVER_ASK_MS hands control over anyway, so a phone left in a pocket can
// never block the show. If the controller disconnects meanwhile, it hands over
// straight away.
const TAKE_OVER_ASK_MS = Number(process.env.TAKE_OVER_ASK_MS) || 15000;
const takeOverRequests = new Map(); // roomId -> { id, requesterId, holderId, timer }

function endTakeOverRequest(roomId, result) {
  const req = takeOverRequests.get(roomId);
  if (!req) return;
  clearTimeout(req.timer);
  takeOverRequests.delete(roomId);
  const requester = io.sockets.sockets.get(req.requesterId);
  const holder = io.sockets.sockets.get(req.holderId);
  if ((result === 'allowed' || result === 'timeout' || result === 'holderLeft') && requester) {
    setRoomController(roomId, requester);
    broadcastControllerStatus(roomId);
  }
  if (requester) requester.emit('takeOverResult', { result, holderName: holder ? holder.deviceName : null });
  if (holder) holder.emit('takeOverRequestEnded', { result, requesterName: requester ? requester.deviceName : null });
}
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

const BG_FITS = ['cover', 'contain', 'stretch'];
// Display digits: font (files in public/fonts) and glow strength.
const DISPLAY_FONTS = ['standard', 'condensed', 'hyperlegible', 'mono', 'led'];
const DISPLAY_GLOWS = ['full', 'soft', 'off'];

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
    countUp: false,    // 'Count down, then up': keep counting the overrun past zero
    countDirection: 'down', // 'down' | 'up' - 'up' is a stopwatch: elapsed from 0:00
    upWarnings: false, // counting up: use amber/red/overrun colours against the set length
    showClock: false,
    outputMode: 'timer', // 'timer' | 'clock'
    timerOnStart: false, // a display showing the clock switches back to the timer on Start
    takeOverAsk: false,  // Take over asks whoever is in control first (see requestControl)
    displayScale: 1.5, // Display size multiplier (0.5 - 2.0)
    // Display appearance - lets an operator brand/chromakey a shared display
    // link without touching the main timer controls. Hex colors; visibility
    // toggles default true so existing rooms behave exactly as before.
    timerColorNormal: '#4caf50',
    timerColorAmber: '#ffb300',
    timerColorRed: '#f44336',
    timerColorOver: '#9c27b0', // overrun: past zero, or past the set length when counting up
    displayBgColor: '#000000',
    displayBgImage: null,  // version string of the room's uploaded background image (room_backgrounds), or null
    displayBgFit: 'cover', // 'cover' (fill, crop edges) | 'contain' (whole image, may letterbox) | 'stretch'
    displayFont: 'standard', // digits font, one of DISPLAY_FONTS
    displayGlow: 'full',     // glow round the digits: 'full' (as always) | 'soft' | 'off'
    displayRedPulse: true,   // digits pulse once in the red
    displayZeroFlash: true,  // digits flash at zero
    showSpeakerName: true,
    showUpNext: true,
    showTimeOfDay: false,  // display: "Now 14:32" line under the timer
    showFinishTime: false, // display: "Finish 14:55" line under the timer
    showStatus: true,      // display: "Running" / "Paused" / "Ready" label under the timer
    showRoomBadge: true,   // display: the small "Room: x" label, bottom right
    rundown: [],       // [{name, durationMs}] programme list
    rundownIndex: -1,  // -1 = not in rundown mode
    message: '',
    messageMode: 'none', // 'none' | 'overlay' | 'ticker'
    messageTickerSpeed: 1.0 // multiplier: 0.5=slow, 1.0=normal, 2.0=fast
  };
}

// Count direction (stopwatch) settings from startTimer / updateSettings.
function applyCountSettings(timerState, data) {
  if (data.countDirection === 'down' || data.countDirection === 'up') timerState.countDirection = data.countDirection;
  if (data.upWarnings !== undefined) timerState.upWarnings = !!data.upWarnings;
}

// Timer-ms elapsed in the current run (0 when stopped).
function elapsedTimerMs(s, nowMs) {
  if (!s.startTime) return 0;
  const end = s.pauseTime || nowMs;
  return Math.max(0, (end - s.startTime - (s.accumulatedPauseMs || 0)) * (s.speed || 1));
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
  noteRemotePeer(socket.handshake.address);
  if (socket.handshake.auth && socket.handshake.auth.screenToken) return handleScreenSocket(socket);
  const token = (socket.handshake.auth && socket.handshake.auth.token) || socket.handshake.query.token;
  if (relayHub) {
    const found = db.getRelayRoomByToken(token);
    if (found) return relayHub.handlePanelSocket(socket, found); // a public link to a Windows laptop's room
  }
  const access = auth.resolveSocketAccess(token);

  if (!access) {
    socket.emit('authError', { message: 'Invalid or expired link. Ask the room owner for a fresh control/display link.' });
    socket.disconnect(true);
    return;
  }

  const { roomId, role } = access; // role: 'control' | 'display' | 'view', derived server-side
  if (!licenceAllowsRoom(roomId)) {
    socket.emit('authError', { reason: 'licence', message: LIMITED_ROOM_MESSAGE });
    socket.disconnect(true);
    return;
  }
  socket.join(roomId);
  if (licence) socket.emit('licenceInfo', { limited: licence.isLimited() });
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
  if (role === 'control' || role === 'view') {
    const proto = socket.handshake.headers['x-forwarded-proto'] || (socket.handshake.secure ? 'https' : 'http');
    const links = buildRoomLinks(shareBaseUrl(proto, socket.handshake.headers.host), access.room);
    // A View link (watch only) gets the display link for its preview, and that's all.
    roomInfo = role === 'control' ? { ...roomInfo, ...links } : { ...roomInfo, displayUrl: links.displayUrl, viewer: true };
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

  // Any control-token holder can take over at any time. By default straight
  // away; with the room's "Ask first" setting the panel in control is asked,
  // and no answer within TAKE_OVER_ASK_MS hands over anyway. Either way a
  // stuck/disconnected "active controller" can never block a legitimate
  // operator during a live event: a missing, reconnecting or same-device
  // holder is never asked.
  socket.on('requestControl', () => {
    if (socket.clientType !== 'control') return;
    const state = getRoomState(roomId);
    const holderId = roomControllers.get(roomId);
    const holder = holderId && io.sockets.sockets.get(holderId);
    const sameDevice = holder && socket.deviceId && holder.deviceId === socket.deviceId;
    if (state && state.takeOverAsk && holder && holder.id !== socket.id && !sameDevice) {
      const pending = takeOverRequests.get(roomId);
      if (pending) {
        if (pending.requesterId !== socket.id) socket.emit('takeOverResult', { result: 'busy', holderName: holder.deviceName || null });
        return;
      }
      const request = { id: crypto.randomBytes(6).toString('hex'), requesterId: socket.id, holderId: holder.id, timer: null };
      request.timer = setTimeout(() => endTakeOverRequest(roomId, 'timeout'), TAKE_OVER_ASK_MS);
      takeOverRequests.set(roomId, request);
      holder.emit('takeOverRequest', { id: request.id, requesterName: socket.deviceName || null, seconds: TAKE_OVER_ASK_MS / 1000 });
      socket.emit('takeOverAsking', { holderName: holder.deviceName || null, seconds: TAKE_OVER_ASK_MS / 1000 });
      return;
    }
    setRoomController(roomId, socket); // also cancels any reservation for a reconnecting controller
    broadcastControllerStatus(roomId);
  });
  // The panel in control answers: { id, allow }
  socket.on('takeOverAnswer', (msg) => {
    const pending = takeOverRequests.get(roomId);
    if (!pending || !msg || msg.id !== pending.id || pending.holderId !== socket.id) return;
    endTakeOverRequest(roomId, msg.allow ? 'allowed' : 'refused');
  });
  // The asking panel gives up.
  socket.on('takeOverCancel', () => {
    const pending = takeOverRequests.get(roomId);
    if (pending && pending.requesterId === socket.id) endTakeOverRequest(roomId, 'cancelled');
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
    if (data.speed !== undefined) timerModes.setSpeed(timerState, data.speed, Date.now());
    if (data.amberThresholdMs !== undefined) timerState.amberThresholdMs = data.amberThresholdMs;
    if (data.redThresholdMs !== undefined) timerState.redThresholdMs = data.redThresholdMs;
    if (data.countUp !== undefined) timerState.countUp = data.countUp;
    applyCountSettings(timerState, data);
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
    if (data.speed !== undefined) timerModes.setSpeed(timerState, data.speed, Date.now());
    if (data.amberThresholdMs !== undefined) timerState.amberThresholdMs = data.amberThresholdMs;
    if (data.redThresholdMs !== undefined) timerState.redThresholdMs = data.redThresholdMs;
    if (data.countUp !== undefined) timerState.countUp = data.countUp;
    applyCountSettings(timerState, data);
    if (data.showClock !== undefined) timerState.showClock = data.showClock;
    if (data.timerOnStart !== undefined) timerState.timerOnStart = !!data.timerOnStart;
    if (data.takeOverAsk !== undefined) timerState.takeOverAsk = !!data.takeOverAsk;
    if (data.displayScale !== undefined) timerState.displayScale = data.displayScale;
    if (isHexColor(data.timerColorNormal)) timerState.timerColorNormal = data.timerColorNormal;
    if (isHexColor(data.timerColorAmber)) timerState.timerColorAmber = data.timerColorAmber;
    if (isHexColor(data.timerColorRed)) timerState.timerColorRed = data.timerColorRed;
    if (isHexColor(data.timerColorOver)) timerState.timerColorOver = data.timerColorOver;
    if (isHexColor(data.displayBgColor)) timerState.displayBgColor = data.displayBgColor;
    if (data.showSpeakerName !== undefined) timerState.showSpeakerName = !!data.showSpeakerName;
    if (data.showUpNext !== undefined) timerState.showUpNext = !!data.showUpNext;
    if (data.showTimeOfDay !== undefined) timerState.showTimeOfDay = !!data.showTimeOfDay;
    if (data.showFinishTime !== undefined) timerState.showFinishTime = !!data.showFinishTime;
    if (data.showStatus !== undefined) timerState.showStatus = !!data.showStatus;
    if (data.showRoomBadge !== undefined) timerState.showRoomBadge = !!data.showRoomBadge;
    if (BG_FITS.includes(data.displayBgFit)) timerState.displayBgFit = data.displayBgFit;
    if (DISPLAY_FONTS.includes(data.displayFont)) timerState.displayFont = data.displayFont;
    if (DISPLAY_GLOWS.includes(data.displayGlow)) timerState.displayGlow = data.displayGlow;
    if (data.displayRedPulse !== undefined) timerState.displayRedPulse = !!data.displayRedPulse;
    if (data.displayZeroFlash !== undefined) timerState.displayZeroFlash = !!data.displayZeroFlash;

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

    // An "Ask first" Take over in progress: the asker leaving cancels it; the
    // panel being asked leaving hands control over now rather than reserving it.
    const pendingAsk = takeOverRequests.get(roomId);
    if (pendingAsk && pendingAsk.requesterId === socket.id) endTakeOverRequest(roomId, 'cancelled');
    else if (pendingAsk && pendingAsk.holderId === socket.id) endTakeOverRequest(roomId, 'holderLeft');

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
        error: "Your organisation’s access to the app is currently paused. Your rooms and settings remain safely stored. Please contact Business Shows for assistance. Once access has been restored, you can log in again as normal.",
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
// Display background image - set from a Control page, shown by its Display
// ============================================
// Authenticated by the room's own link token, like the sockets: the control
// token to change it, either token to fetch it. Changing it also needs the
// caller's socket id to be the room's active controller (X-Socket-Id), the same
// rule every socket mutation follows - an observer panel can't change the show.

const BG_MAX_BYTES = 10 * 1024 * 1024;

// The file's own first bytes decide what it is - never the declared type.
function sniffImageMime(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function roomFromToken(req) {
  return auth.resolveSocketAccess(req.get('X-Room-Token') || req.query.token);
}

function requireBackgroundController(req, res, next) {
  const access = roomFromToken(req);
  if (!access) return res.status(401).json({ ok: false, error: 'Invalid or expired link.' });
  if (access.role !== 'control') return res.status(403).json({ ok: false, error: 'Display links cannot change the display.' });
  if (!timerRooms.get(access.roomId)) return res.status(404).json({ ok: false, error: 'Room not found.' });
  if (roomControllers.get(access.roomId) !== req.get('X-Socket-Id')) {
    return res.status(409).json({ ok: false, error: 'This panel is view only. Take over first.' });
  }
  req.roomId = access.roomId;
  next();
}

// A public link (Share over the internet) can't upload: the image lives on the laptop.
function refusePublicBackgroundChange(req, res, next) {
  if (relayHub && db.getRelayRoomByToken(req.get('X-Room-Token') || req.query.token)) {
    return res.status(409).json({ ok: false, error: 'Change the background image on the show laptop.' });
  }
  next();
}

app.put('/api/display-background', refusePublicBackgroundChange, requireBackgroundController,
  express.raw({ type: () => true, limit: BG_MAX_BYTES }), (req, res) => {
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const mime = sniffImageMime(data);
    if (!mime) return res.status(415).json({ ok: false, error: 'That file is not a PNG, JPEG or WebP image.' });
    db.setRoomBackground(Number(req.roomId), mime, data);
    const timerState = timerRooms.get(req.roomId);
    timerState.displayBgImage = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    emitState(req.roomId, timerState);
    scheduleSave();
    res.json({ ok: true, version: timerState.displayBgImage });
  });

app.delete('/api/display-background', refusePublicBackgroundChange, requireBackgroundController, (req, res) => {
  db.deleteRoomBackground(Number(req.roomId));
  const timerState = timerRooms.get(req.roomId);
  timerState.displayBgImage = null;
  emitState(req.roomId, timerState);
  scheduleSave();
  res.json({ ok: true });
});

// ?token=<control or display token>&v=<version>. The version is in the URL, so a
// given URL's bytes never change and can be cached for as long as the browser likes.
app.get('/api/display-background', async (req, res) => {
  const relayed = relayHub && db.getRelayRoomByToken(req.query.token);
  if (relayed) {
    const bg = await relayHub.fetchBackground(relayed.relayRoom);
    if (!bg) return res.status(404).end();
    res.set({ 'Content-Type': bg.mime, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
    return res.send(Buffer.from(bg.data, 'base64'));
  }
  const access = roomFromToken(req);
  if (!access) return res.status(401).end();
  const bg = db.getRoomBackground(Number(access.roomId));
  if (!bg) return res.status(404).end();
  res.set({
    'Content-Type': bg.mime,
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff'
  });
  res.send(bg.data);
});

// Upload too big (express.raw's limit) - a JSON answer the Control page can show.
app.use('/api/display-background', (err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, error: `Image is too big - the limit is ${BG_MAX_BYTES / 1024 / 1024} MB.` });
  }
  next(err);
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

  const baseUrl = shareBaseUrl(req.protocol, req.get('host'));
  const links = buildRoomLinks(baseUrl, row);
  const publicLinks = relayAgent ? relayAgent.status().links[roomId] : null;

  return {
    publicControlUrl: publicLinks ? publicLinks.controlUrl : null,
    publicDisplayUrl: publicLinks ? publicLinks.displayUrl : null,
    publicViewUrl: publicLinks ? publicLinks.viewUrl || null : null,
    id: roomId,
    slug: row.slug,
    clientName: row.client_name || null, // only present in the platform-admin listing
    mode: state.mode,
    connections: connectionCount,
    remainingMs: Math.floor(remainingMs),
    overMs: Math.floor(overMs),
    outputMode: state.outputMode,
    countUp: state.countUp || false,
    countDirection: state.countDirection || 'down',
    elapsedMs: Math.floor(elapsedTimerMs(state, Date.now())),
    amberThresholdMs: state.amberThresholdMs,
    redThresholdMs: state.redThresholdMs,
    controlUrl: links.controlUrl,
    displayUrl: links.displayUrl,
    viewUrl: links.viewUrl || null,
    licenceLocked: !licenceAllowsRoom(roomId)
  };
}

// Tells the dashboard who it's talking to, so it knows whether to render the
// platform-admin (cross-client) view or the normal single-client view.
app.get('/api/whoami', auth.requireDashboardAuth, (req, res) => {
  res.json({
    ok: true,
    clientId: req.client.id,
    name: req.client.name,
    isPlatformAdmin: !!req.client.is_platform_admin,
    localOperator: req.authMethod === 'localOperator'
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
  if (licence && licence.isLimited() && db.getRoomsForClient(req.client.id).length >= 1) {
    return res.status(403).json({ ok: false, reason: 'licence', error: 'The free version of Foxy Timer for Windows runs one room.' });
  }

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
  republishRooms();

  const baseUrl = shareBaseUrl(req.protocol, req.get('host'));
  const links = buildRoomLinks(baseUrl, room);
  res.json({ ok: true, roomId: String(room.id), slug: cleanSlug, ...links });
});

// Delete room endpoint
app.delete('/api/rooms/:roomId', auth.requireDashboardAuth, auth.resolveOwnedRoom, (req, res) => {
  const { roomId, room } = req;

  timerRooms.delete(roomId);
  forgetRoomController(roomId);
  const screensShowingRoom = db.listScreensForRoom(room.id);
  db.deleteRoom(room.id);
  screensShowingRoom.forEach((sc) => notifyScreen(sc.id));


  const socketsInRoom = io.sockets.adapter.rooms.get(roomId);
  if (socketsInRoom) {
    for (const socketId of socketsInRoom) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) socket.disconnect(true);
    }
  }

  console.log(`🗑️  Manually deleted room: ${room.slug} (id=${roomId})`);
  republishRooms();
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

  db.listScreensForRoom(updated.id).forEach((sc) => notifyScreen(sc.id)); // they follow the new display link

  const baseUrl = shareBaseUrl(req.protocol, req.get('host'));
  const links = buildRoomLinks(baseUrl, updated);
  res.json({ ok: true, roomId: req.roomId, ...links });
});

// ============================================
// Paired screens
//
// A browser opens /screen (one fixed address, e.g. a Raspberry Pi kiosk), gets
// a random token it keeps, and shows a pairing code. Someone enters the code on
// their dashboard, names the screen and picks a room; from then on the screen
// shows that room's display and follows any change made on the dashboard,
// including New links, without anyone touching it.
// ============================================

const screenSockets = new Map(); // screen id -> Set of socket ids
const screenNewLimiter = demoRooms.createHourlyLimiter(30);  // pending screens per IP per hour
const screenPairLimiter = demoRooms.createHourlyLimiter(60); // pairing attempts per client per hour

function screenIsOnline(id) {
  const set = screenSockets.get(Number(id));
  return !!set && set.size > 0;
}

// What a screen should show now.
function screenPayload(screen) {
  if (!screen) return { state: 'unknown' };
  if (!screen.client_id) return { state: 'pending', code: screen.pair_code };
  const client = db.getClientById(screen.client_id);
  const room = screen.room_id ? db.getRoomById(screen.room_id) : null;
  const base = { name: screen.name || 'Screen' };
  if (!client || client.status !== 'active') return { ...base, state: 'idle', note: 'This account is paused.' };
  if (!room) return { ...base, state: 'idle' };
  if (!licenceAllowsRoom(String(room.id))) return { ...base, state: 'idle', note: LIMITED_ROOM_MESSAGE };
  return { ...base, state: 'room', roomName: room.slug, displayToken: room.display_token };
}

function notifyScreen(id) {
  const screen = db.getScreenById(id);
  io.to(`screen:${id}`).emit('screenAssignment', screenPayload(screen));
}

function handleScreenSocket(socket) {
  const screen = db.getScreenByToken(socket.handshake.auth.screenToken);
  if (!screen) {
    socket.emit('screenAssignment', { state: 'unknown' }); // the page asks for a new code
    socket.disconnect(true);
    return;
  }
  const id = Number(screen.id);
  socket.join(`screen:${id}`);
  if (!screenSockets.has(id)) screenSockets.set(id, new Set());
  screenSockets.get(id).add(socket.id);
  db.touchScreen(id);
  socket.emit('screenAssignment', screenPayload(screen));
  socket.on('disconnect', () => {
    const set = screenSockets.get(id);
    if (set) { set.delete(socket.id); if (!set.size) screenSockets.delete(id); }
    if (db.getScreenById(id)) db.touchScreen(id);
  });
}

function summarizeScreen(sc) {
  return {
    id: String(sc.id),
    name: sc.name || 'Screen',
    roomId: sc.room_id ? String(sc.room_id) : null,
    roomName: sc.room_slug || null,
    online: screenIsOnline(sc.id),
    lastSeenAt: sc.last_seen_at || null,
  };
}

function cleanScreenName(name) {
  return typeof name === 'string' ? name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60) : '';
}

// roomId from the dashboard: null/'' = show nothing; otherwise one of this client's rooms.
function resolveScreenRoom(req, roomId) {
  if (roomId === null || roomId === undefined || roomId === '') return { ok: true, roomId: null };
  const room = db.getRoomById(Number(roomId));
  if (!room || !db.getRoomsForClient(req.client.id).some((r) => r.id === room.id)) {
    return { ok: false, error: 'That room is not one of yours.' };
  }
  return { ok: true, roomId: room.id };
}

// A screen asks for a pairing code. No account needed (that's the point), so
// limited per IP; unpaired screens are deleted after an hour.
app.post('/api/screens/new', async (req, res) => {
  if (!screenNewLimiter.take(req.ip)) {
    return res.status(429).json({ ok: false, error: 'Too many new screens from this network. Try again later.' });
  }
  const pending = db.createPendingScreen();
  const pairUrl = `${shareBaseUrl(req.protocol, req.get('host'))}/dashboard?pair=${pending.code}`;
  const qrSvg = await QRCode.toString(pairUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.json({ ok: true, token: pending.token, code: pending.code, qrSvg });
});

app.get('/api/screens', auth.requireDashboardAuth, (req, res) => {
  const screenUrl = `${shareBaseUrl(req.protocol, req.get('host'))}/screen`;
  res.json({ ok: true, screenUrl, screens: db.listScreensForClient(req.client.id).map(summarizeScreen) });
});

app.post('/api/screens/pair', auth.requireDashboardAuth, (req, res) => {
  if (!screenPairLimiter.take(String(req.client.id))) {
    return res.status(429).json({ ok: false, error: 'Too many pairing attempts. Wait a few minutes and try again.' });
  }
  const { code, name, roomId } = req.body || {};
  const pending = db.getPendingScreenByCode(code);
  if (!pending) {
    return res.status(404).json({ ok: false, error: 'No screen is showing that code. Check it, or reload the screen to get a new one.' });
  }
  const room = resolveScreenRoom(req, roomId);
  if (!room.ok) return res.status(400).json({ ok: false, error: room.error });
  const paired = db.pairScreen(pending.id, req.client.id, cleanScreenName(name) || 'Screen', room.roomId);
  notifyScreen(paired.id);
  console.log(`🖥️  Screen "${paired.name}" (id=${paired.id}) paired to client "${req.client.name}"`);
  res.json({ ok: true, screen: summarizeScreen({ ...paired, room_slug: room.roomId ? db.getRoomById(room.roomId).slug : null }) });
});

app.patch('/api/screens/:id', auth.requireDashboardAuth, (req, res) => {
  const screen = db.getScreenForClient(Number(req.params.id), req.client.id);
  if (!screen) return res.status(404).json({ ok: false, error: 'Screen not found' });
  const body = req.body || {};
  const changes = {};
  if (body.name !== undefined) {
    const name = cleanScreenName(body.name);
    if (!name) return res.status(400).json({ ok: false, error: 'Give the screen a name.' });
    changes.name = name;
  }
  if (body.roomId !== undefined) {
    const room = resolveScreenRoom(req, body.roomId);
    if (!room.ok) return res.status(400).json({ ok: false, error: room.error });
    changes.roomId = room.roomId;
  }
  db.updateScreen(screen.id, changes);
  notifyScreen(screen.id);
  const updated = db.listScreensForClient(req.client.id).find((sc) => sc.id === screen.id);
  res.json({ ok: true, screen: summarizeScreen(updated) });
});

app.delete('/api/screens/:id', auth.requireDashboardAuth, (req, res) => {
  const screen = db.getScreenForClient(Number(req.params.id), req.client.id);
  if (!screen) return res.status(404).json({ ok: false, error: 'Screen not found' });
  db.deleteScreen(screen.id);
  io.to(`screen:${screen.id}`).emit('screenAssignment', { state: 'unknown' }); // it shows a new code
  io.in(`screen:${screen.id}`).disconnectSockets(true);
  res.json({ ok: true });
});

// Unpaired screens expire after an hour; one still open gets a fresh code.
setInterval(() => {
  for (const id of db.deleteExpiredPendingScreens()) {
    io.to(`screen:${id}`).emit('screenAssignment', { state: 'unknown' });
    io.in(`screen:${id}`).disconnectSockets(true);
  }
}, 5 * 60 * 1000).unref();

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
  emitState(roomId, timerState);
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
  emitState(roomId, timerState);
  scheduleSave();
  res.json({ ok: true, roomId, slug: room.slug, clientName: room.client_name, state: timerState });
});

app.post('/api/admin/rooms/:id/resume', ...adminRoomAuth, (req, res) => {
  const { roomId, timerState, room } = req;
  if (timerState.mode !== 'paused') {
    return res.json({ ok: false, error: 'Timer is not paused' });
  }
  timerModes.resumeTimer(timerState, Date.now());
  emitState(roomId, timerState);
  scheduleSave();
  res.json({ ok: true, roomId, slug: room.slug, clientName: room.client_name, state: timerState });
});

app.post('/api/admin/rooms/:id/reset', ...adminRoomAuth, (req, res) => {
  const { roomId, timerState, room } = req;
  timerModes.resetTimer(timerState, Date.now());
  emitState(roomId, timerState);
  scheduleSave();
  res.json({ ok: true, roomId, slug: room.slug, clientName: room.client_name, state: timerState });
});

app.delete('/api/admin/rooms/:id', auth.requireDashboardAuth, auth.requirePlatformAdmin, auth.resolveRoomById, (req, res) => {
  const { roomId, room } = req;

  timerRooms.delete(roomId);
  forgetRoomController(roomId);
  const screensShowingRoom = db.listScreensForRoom(room.id);
  db.deleteRoom(room.id);
  screensShowingRoom.forEach((sc) => notifyScreen(sc.id));


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

  db.listScreensForRoom(updated.id).forEach((sc) => notifyScreen(sc.id));

  const baseUrl = shareBaseUrl(req.protocol, req.get('host'));
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

function requireLicensedRoom(req, res, next) {
  if (!licenceAllowsRoom(req.roomId)) return res.status(403).json({ ok: false, reason: 'licence', error: LIMITED_ROOM_MESSAGE });
  next();
}

const roomAuth = [auth.requireDashboardAuth, auth.resolveOwnedRoom, requireLicensedRoom, attachTimerState];

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

  // Counting up (stopwatch): the buttons show elapsed time, like the display.
  const countingUp = s.countDirection === 'up';
  const shownMs = countingUp ? elapsedTimerMs(s, Date.now()) : remainingMs;
  const totalSec = Math.floor(Math.max(0, shownMs) / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  const sign = isOvertime && s.countUp && !countingUp ? '-' : '';
  const timeDisplay = `${sign}${String(min).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;

  // Colour: matches display screen thresholds
  let color = 'green';
  if (s.mode === 'stopped')                          color = 'stopped';
  else if (s.mode === 'paused')                      color = 'paused';
  else if (countingUp && !s.upWarnings)              color = 'green';
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
    countDirection: s.countDirection || 'down',
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
    outputMode:    s.outputMode,
    countStyle:    countingUp ? 'up' : (s.countUp ? 'downUp' : 'down'),
    timerOnStart:  !!s.timerOnStart,
    messageMode:   s.messageMode || 'none',
    speed:         s.speed || 1,
    // When the timer reaches 0:00 (epoch ms): running = the real finish; paused or
    // stopped = "if started/resumed now". null when counting up or already past 0:00.
    // Companion shows it in its own PC's time zone.
    endsAtMs:      countingUp || isOvertime ? null
      : (s.mode === 'running' && Number.isFinite(s.runEndAtMs)) ? Math.round(s.runEndAtMs)
      : Math.round(Date.now() + Math.max(0, remainingMs) / (s.speed || 1)),
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

  emitState(roomId, timerState);
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

  emitState(roomId, timerState);
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

  emitState(roomId, timerState);
  scheduleSave();

  res.json({ ok: true, roomId: req.params.roomId, state: timerState });
});

// POST reset timer
app.post('/api/rooms/:roomId/reset', ...roomAuth, (req, res) => {
  const { roomId } = req;
  const timerState = req.timerState;

  timerModes.resetTimer(timerState, Date.now());

  emitState(roomId, timerState);
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

  // Same as the control page's nudge buttons. (This used to shift startTime,
  // which reversed a running timer's nudges - +1 min took a minute off - and
  // ignored speed and End at runs.)
  timerModes.nudge(timerState, ms, Date.now());

  emitState(roomId, timerState);
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

  emitState(roomId, timerState);
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
  if (!s.rundown.length) return res.json({ ok: false, error: 'No running order set up' });
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
  if (!s.rundown.length) return res.json({ ok: false, error: 'No running order set up' });
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
  if (!s.rundown.length) return res.json({ ok: false, error: 'No running order set up' });
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

// POST what the display shows. Body: { mode: 'timer' | 'clock' | 'toggle' }
app.post('/api/rooms/:roomId/output', ...roomAuth, (req, res) => {
  const s = req.timerState;
  const want = req.body && req.body.mode;
  const mode = want === 'toggle' ? (s.outputMode === 'clock' ? 'timer' : 'clock') : want;
  if (mode !== 'timer' && mode !== 'clock') return res.json({ ok: false, error: 'mode must be "timer", "clock" or "toggle"' });
  s.outputMode = mode;
  s.showClock = mode === 'clock';
  emitState(req.roomId, s);
  scheduleSave();
  res.json({ ok: true, roomId: req.params.roomId, outputMode: mode });
});

// POST how the timer counts. Body: { style: 'down' | 'downUp' | 'up' } (the control page's Count menu),
// { timerOnStart: boolean } ("Back to timer on Start"), { speed } or { speedStep } (timer speed).
app.post('/api/rooms/:roomId/settings', ...roomAuth, (req, res) => {
  const s = req.timerState;
  const { style, timerOnStart, speed, speedStep } = req.body || {};
  if (style !== undefined) {
    if (!['down', 'downUp', 'up'].includes(style)) return res.json({ ok: false, error: 'style must be "down", "downUp" or "up"' });
    s.countDirection = style === 'up' ? 'up' : 'down';
    s.countUp = style === 'downUp';
  }
  if (timerOnStart !== undefined) s.timerOnStart = !!timerOnStart;
  // Timer speed: { speed: 1 } sets it, { speedStep: 0.05 } nudges it.
  if (typeof speed === 'number' && Number.isFinite(speed)) timerModes.setSpeed(s, speed, Date.now());
  else if (typeof speedStep === 'number' && Number.isFinite(speedStep)) timerModes.setSpeed(s, (s.speed || 1) + speedStep, Date.now());
  emitState(req.roomId, s);
  scheduleSave();
  res.json({ ok: true, roomId: req.params.roomId });
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

// ---- Share over the internet ----
// Online: the hub that public links connect to. Laptop: the agent that connects
// out to Online (only while the operator has it switched on). See relayHub.js /
// relayAgent.js.
const PUBLIC_ONLINE_URL = (process.env.FOXY_ONLINE_URL || 'https://foxytimer.com').replace(/\/$/, '');
function publicBase(headers, secure) {
  if (process.env.FOXY_PUBLIC_URL) return process.env.FOXY_PUBLIC_URL.replace(/\/$/, '');
  const proto = (headers['x-forwarded-proto'] || '').split(',')[0] || (secure ? 'https' : 'http');
  return `${proto}://${headers.host}`;
}
function publicLinksFromRequest(row, req) {
  return buildRoomLinks(publicBase(req.headers, req.secure), { control_token: row.control_token, display_token: row.display_token, view_token: row.view_token });
}
const relayHub = LOCAL_MODE ? null : createRelayHub({
  io, db, log: (m) => console.log(m),
  buildPublicLinks: (row, handshake) => buildRoomLinks(publicBase(handshake.headers, handshake.secure), { control_token: row.control_token, display_token: row.display_token, view_token: row.view_token }),
});
const relayAgent = LOCAL_MODE ? createRelayAgent({
  db, port: Number(process.env.PORT || 3000), onlineUrl: PUBLIC_ONLINE_URL, log: (m) => console.log(m),
  getRooms: () => db.getRoomsForClient(db.getOrCreateLocalClient().id).map((r) => ({ localId: String(r.id), slug: r.slug })),
}) : null;
function republishRooms() { if (relayAgent) relayAgent.publish(); }

// A laptop asks for public links the first time it's switched on. No account:
// limited per network, and it can only ever publish its own rooms.
const relayRegisterLimiter = demoRooms.createHourlyLimiter(10);
app.post('/api/relay/register', (req, res) => {
  if (LOCAL_MODE) return res.status(404).json({ ok: false, error: 'Not available on Foxy Timer for Windows' });
  if (!relayRegisterLimiter.take(req.ip)) return res.status(429).json({ ok: false, error: 'Too many requests from this network. Try again later.' });
  const session = db.createRelaySession();
  res.json({ ok: true, secret: session.secret });
});

// Foxy Timer for Windows trial (licence.js). Full or limited is decided at
// startup; limited = the first room only, plus a small mark on displays.
// Online has no licence (null) and is never limited.
const licence = LOCAL_MODE ? createLicenceManager({
  getMeta: db.getMeta,
  setMeta: db.setMeta,
  appVersion: STARTED_BUILD.label,
  onChange: (info) => {
    console.log('🔓 Foxy Timer for Windows: full version active');
    io.emit('licenceInfo', { limited: info.limited });
  }
}) : null;
const LIMITED_ROOM_MESSAGE = 'The free version of Foxy Timer for Windows runs one room. Open the dashboard on the show laptop to see your options.';

function licenceAllowsRoom(roomId) {
  if (!licence || !licence.isLimited()) return true;
  const ids = db.getRoomsForClient(db.getOrCreateLocalClient().id).map((r) => r.id);
  return ids.length > 0 && String(Math.min(...ids)) === String(roomId);
}
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

// The front page's contact form and "Try it now" demo rooms belong to Foxy
// Timer Online; on a show laptop they'd only let LAN devices fill its database.
function onlineOnly(req, res, next) {
  if (process.env.FOXY_MODE === 'local') return res.status(404).json({ ok: false, error: 'Not available on Foxy Timer for Windows' });
  next();
}

app.post('/api/contact', onlineOnly, (req, res) => {
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
// Foxy Timer for Windows: download link and trial licences (see trials.js).
// The download itself is hosted elsewhere (too big for Railway); /download/windows
// redirects to the admin-set link so the website never needs editing for a release.
// ============================================
const TRIAL_RATE_WINDOW_MS = 60 * 60 * 1000;
const TRIAL_RATE_LIMIT = 20;
const trialAttempts = new Map();

function windowsTrialSettings() {
  return db.getWindowsTrialSettings(trials.DEFAULT_TRIAL_DAYS);
}

app.get('/api/windows/info', onlineOnly, (req, res) => {
  const { trialDays, downloadUrl } = windowsTrialSettings();
  res.json({ ok: true, trialDays, downloadAvailable: Boolean(downloadUrl) });
});

app.get('/download/windows', onlineOnly, (req, res) => {
  const { downloadUrl } = windowsTrialSettings();
  if (!downloadUrl) return res.status(404).send('Foxy Timer for Windows is not available to download yet.');
  res.redirect(302, downloadUrl);
});

// Called by the Windows app on first launch (and whenever it's online later,
// to pick up an extension). Same machine always gets its original expiry.
app.post('/api/windows/trial', onlineOnly, (req, res) => {
  const now = Date.now();
  const recent = (trialAttempts.get(req.ip) || []).filter((t) => now - t < TRIAL_RATE_WINDOW_MS);
  if (recent.length >= TRIAL_RATE_LIMIT) {
    trialAttempts.set(req.ip, recent);
    return res.status(429).json({ ok: false, error: 'Too many requests. Please try again later.' });
  }
  recent.push(now);
  trialAttempts.set(req.ip, recent);

  const { machineId, appVersion } = req.body || {};
  if (!trials.isValidMachineId(machineId)) return res.status(400).json({ ok: false, error: 'Invalid machine id' });
  if (!trials.isConfigured()) return res.status(503).json({ ok: false, error: 'Trials are not set up on this server' });

  const version = typeof appVersion === 'string' ? appVersion.slice(0, 40) : null;
  const trial = db.getOrStartWindowsTrial(machineId, windowsTrialSettings().trialDays, version);
  const licence = trials.signLicence({
    id: trial.id, machine: trial.machine_id, issuedAt: trial.issued_at, expiresAt: trial.expires_at
  });
  res.json({ ok: true, licence, expiresAt: trial.expires_at, started: trial.started });
});

app.get('/api/admin/windows-trials', ...adminClientAuth, (req, res) => {
  res.json({
    ok: true,
    settings: { ...windowsTrialSettings(), maxTrialDays: trials.MAX_TRIAL_DAYS, signingConfigured: trials.isConfigured() },
    trials: db.listWindowsTrials()
  });
});

app.post('/api/admin/windows-trials/settings', ...adminClientAuth, (req, res) => {
  const body = req.body || {};
  const update = {};
  if (body.trialDays !== undefined) {
    update.trialDays = trials.parseTrialDays(body.trialDays);
    if (update.trialDays === null) return res.status(400).json({ ok: false, error: `Trial length must be 1-${trials.MAX_TRIAL_DAYS} days` });
  }
  if (body.downloadUrl !== undefined) {
    update.downloadUrl = trials.parseDownloadUrl(body.downloadUrl);
    if (update.downloadUrl === null) return res.status(400).json({ ok: false, error: 'Download link must start with https://' });
  }
  db.setWindowsTrialSettings(update);
  const settings = windowsTrialSettings();
  db.recordAuditLog({
    actorUserId: req.user.id,
    action: 'windows_trial.settings',
    targetType: 'setting',
    targetLabel: `${settings.trialDays} days`
  });
  res.json({ ok: true, settings });
});

// Adds days from whichever is later: now or the current expiry, so extending
// an expired trial gives the full number of days from today.
app.post('/api/admin/windows-trials/:id/extend', ...adminClientAuth, (req, res) => {
  const id = Number(req.params.id);
  const trial = Number.isInteger(id) ? db.getWindowsTrialById(id) : null;
  if (!trial) return res.status(404).json({ ok: false, error: 'Trial not found' });
  const days = trials.parseTrialDays(req.body && req.body.days);
  if (days === null) return res.status(400).json({ ok: false, error: `Days must be 1-${trials.MAX_TRIAL_DAYS}` });
  db.setWindowsTrialExpiry(id, Math.max(Date.now(), trial.expires_at) + days * trials.DAY_MS);
  db.recordAuditLog({
    actorUserId: req.user.id,
    action: 'windows_trial.extended',
    targetType: 'windows_trial',
    targetId: id,
    targetLabel: `+${days} days`
  });
  res.json({ ok: true, trial: db.getWindowsTrialById(id) });
});

// ============================================
// Local Show Server: Companion (Stream Deck) setup details for the laptop's
// dashboard - the server address other machines use, the local API key, and
// the room names Companion's "Room IDs" field wants. Only for the operator at
// the show laptop itself (see auth.isLocalOperatorRequest).
// ============================================
function requireLocalOperator(req, res, next) {
  if (req.authMethod !== 'localOperator') {
    return res.status(403).json({ ok: false, error: 'Only available on the show laptop itself' });
  }
  next();
}

function localCompanionDetails(req, apiKey) {
  return {
    ok: true,
    serverUrl: shareBaseUrl(req.protocol, req.get('host')),
    apiKey,
    rooms: db.getRoomsForClient(req.client.id).map((r) => r.slug)
  };
}

app.get('/api/local/companion', auth.requireDashboardAuth, requireLocalOperator, (req, res) => {
  res.json(localCompanionDetails(req, db.getOrCreateLocalCompanionKey()));
});

app.post('/api/local/companion/new-key', auth.requireDashboardAuth, requireLocalOperator, (req, res) => {
  res.json(localCompanionDetails(req, db.newLocalCompanionKey()));
});

// Foxy Timer Online: the same Companion window for a logged-in customer. Keys
// are stored only as a hash, so the current key can't be shown again - the
// window says when it was made, and "Make a new key" shows the new one once.
// Logged-in humans only: a Companion connection (Bearer key) must not be able
// to replace the key it is using, and the laptop has its own routes above.
function requireOnlineSession(req, res, next) {
  if (req.authMethod !== 'session') {
    return res.status(403).json({ ok: false, error: 'Log in to the dashboard to set up Companion' });
  }
  next();
}

function onlineCompanionDetails(req, apiKey) {
  const client = db.getClientById(req.client.id);
  return {
    ok: true,
    serverUrl: shareBaseUrl(req.protocol, req.get('host')),
    apiKey: apiKey || null,
    keyMadeAt: client.api_key_rotated_at || client.api_key_created_at || null,
    rooms: db.getRoomsForClient(req.client.id).map((r) => r.slug)
  };
}

app.get('/api/companion', auth.requireDashboardAuth, requireOnlineSession, (req, res) => {
  res.json(onlineCompanionDetails(req));
});

app.post('/api/companion/new-key', auth.requireDashboardAuth, requireOnlineSession, (req, res) => {
  const rotated = db.rotateClientApiKeyById(req.client.id);
  db.recordAuditLog({
    actorUserId: req.user.id,
    action: 'client.rotate_api_key',
    targetType: 'client',
    targetId: req.client.id,
    targetLabel: req.client.name
  });
  res.json(onlineCompanionDetails(req, rotated.apiKey));
});

// "This laptop" panel on the dashboard: status, network addresses, whether
// Windows Firewall lets other devices in (checked in the background and cached
// - it takes a couple of seconds - so it never holds up anything else), and
// Stop / Restart. Laptop-only, like the Companion details.
let firewallCache = { at: 0, alias: null, result: null, pending: null };
const FIREWALL_CACHE_MS = 20000;

function firewallStatus(alias, { refresh = false } = {}) {
  const fresh = firewallCache.result && firewallCache.alias === alias && Date.now() - firewallCache.at < FIREWALL_CACHE_MS;
  if (fresh && !refresh) return Promise.resolve(firewallCache.result);
  if (firewallCache.pending) return firewallCache.pending;
  firewallCache.pending = firewall.checkFirewall(process.execPath, alias)
    .catch(() => ({ state: 'unknown', reason: 'check-failed' }))
    .then((result) => {
      firewallCache = { at: Date.now(), alias, result, pending: null };
      return result;
    });
  return firewallCache.pending;
}

// Proof that another device really reached this laptop. The firewall check
// only covers the laptop itself; venue and guest Wi-Fi often keeps devices
// apart ("client isolation"), which nothing on the laptop can see - so the
// dashboard says "not tested yet" until a phone, screen or Companion PC gets
// through, and offers /check (QR on the dashboard) to test with a phone.
let lastRemoteDevice = null; // { at, address }
function noteRemotePeer(address) {
  if (!LOCAL_MODE || !address) return;
  if (lastRemoteDevice && Date.now() - lastRemoteDevice.at < 10000) return;
  if (auth.isThisMachineAddress(address)) return;
  lastRemoteDevice = { at: Date.now(), address: String(address).replace(/^::ffff:/, '') };
}

app.get('/check', (req, res) => {
  if (!LOCAL_MODE) return res.status(404).send('Not found');
  res.set('Cache-Control', 'no-store');
  res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Foxy Timer connection check</title>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0a;color:#f5f5f5;font-family:-apple-system,Segoe UI,Roboto,sans-serif;text-align:center;padding:24px;box-sizing:border-box">
<div><div style="font-size:64px;color:#4caf50">✓</div><h1 style="font-size:1.4rem;margin:8px 0">This device can reach Foxy Timer</h1>
<p style="color:#aaa;line-height:1.5">The show laptop now shows the check as passed.<br>Control and Display links will work from here too.</p></div></body>`);
});

// Which of this laptop's networks other devices should use. Automatic picks
// the first real adapter Windows lists, which can be the wrong one when the
// laptop is on two networks (e.g. venue Wi-Fi + a closed show network), so the
// operator can choose. Kept by adapter NAME: the address it gets can change.
function chosenLan() {
  const lan = selectLanAddresses();
  const preferred = process.env.FOXY_MODE === 'local' ? db.getMeta('lan_adapter') : null;
  const picked = preferred ? lan.candidates.find((c) => c.name === preferred) : null;
  return { ...lan, primary: picked || lan.primary, preferred: preferred || null, preferredMissing: !!preferred && !picked };
}

async function laptopStatus(req, opts) {
  const lan = chosenLan();
  const port = Number(process.env.PORT || 3000);
  // The chosen network first: the dashboard treats addresses[0] as "the" address.
  const ordered = lan.primary ? [lan.primary].concat(lan.candidates.filter((c) => c !== lan.primary)) : lan.candidates;
  return {
    ok: true,
    pid: process.pid,
    startedAt: new Date(STARTED_AT).toISOString(),
    build: STARTED_BUILD.label,
    port,
    addresses: ordered.map((c) => ({ name: c.name, address: c.address, url: `http://${c.address}:${port}`, virtual: c.virtual })),
    addressChoice: lan.preferred && !lan.preferredMissing ? lan.preferred : null, // null = automatic
    addressChoiceMissing: lan.preferredMissing ? lan.preferred : null,
    firewall: lan.primary ? await firewallStatus(lan.primary.name, opts) : { state: 'unknown', reason: 'no-network' },
    remoteDevice: lastRemoteDevice
  };
}

app.get('/api/local/status', auth.requireDashboardAuth, requireLocalOperator, async (req, res) => {
  res.json(await laptopStatus(req, { refresh: req.query.refresh === '1' }));
});

// Trial status for the dashboard's banner, and a "Check again" that asks
// Foxy Timer Online straight away (e.g. after connecting to the internet).
app.get('/api/local/licence', auth.requireDashboardAuth, requireLocalOperator, (req, res) => {
  res.json({ ok: true, ...licence.info() });
});

app.post('/api/local/licence/check', auth.requireDashboardAuth, requireLocalOperator, async (req, res) => {
  res.json({ ok: true, ...(await licence.checkIn()) });
});

// Share over the internet: { enabled: true | false }
app.get('/api/local/relay', auth.requireDashboardAuth, requireLocalOperator, (req, res) => {
  res.json({ ok: true, ...relayAgent.status() });
});
app.post('/api/local/relay', auth.requireDashboardAuth, requireLocalOperator, async (req, res) => {
  const on = !!(req.body && req.body.enabled);
  res.json({ ok: true, ...(on ? await relayAgent.start() : relayAgent.stop()) });
});

// Choose the network other devices use: { adapter: name } or { adapter: null } for automatic.
app.post('/api/local/address', auth.requireDashboardAuth, requireLocalOperator, async (req, res) => {
  const adapter = req.body && req.body.adapter;
  if (adapter === null || adapter === undefined || adapter === '') {
    db.setMeta('lan_adapter', '');
  } else if (typeof adapter === 'string' && selectLanAddresses().candidates.some((c) => c.name === adapter)) {
    db.setMeta('lan_adapter', adapter);
  } else {
    return res.status(400).json({ ok: false, error: 'That network is not connected.' });
  }
  res.json(await laptopStatus(req, { refresh: true }));
});

app.post('/api/local/firewall/allow', auth.requireDashboardAuth, requireLocalOperator, async (req, res) => {
  const result = await firewall.allowThroughFirewall(process.execPath);
  const status = await laptopStatus(req, { refresh: true });
  res.json({ ...status, fix: result });
});

// Stop: save and exit (the launcher's PID file then reads as stale, which it
// already handles). Restart: hand over to the launcher's own restart, run as a
// separate process, so the old server is stopped and the new one started by
// the same code path as the launcher menu.
app.post('/api/local/stop', auth.requireDashboardAuth, requireLocalOperator, (req, res) => {
  res.json({ ok: true });
  console.log('👋 Stop requested from the dashboard - saving state and exiting.');
  setTimeout(() => { clearTimeout(saveTimeout); persistRooms(); process.exit(0); }, 200);
});

app.post('/api/local/restart', auth.requireDashboardAuth, requireLocalOperator, (req, res) => {
  const launcher = path.join(__dirname, 'tools', 'local-server', 'foxy-local.js');
  const child = spawn(process.execPath, [launcher, 'restart'], {
    detached: true, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, FOXY_PORT: String(process.env.PORT || 3000) }
  });
  child.unref();
  res.json({ ok: true, oldPid: process.pid });
});

// QR code (SVG) for a room link, for the dashboard. Authenticated so it isn't
// an open QR service; POST so the token in the link stays out of URLs/logs.
// The control page's Share links window: both links with QR codes, for a
// room's CONTROL token only (a display link must never reveal the control link).
app.post('/api/room-links', async (req, res) => {
  const token = req.body && req.body.token;
  const qr = (text) => QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  const relayed = relayHub && db.getRelayRoomByToken(token);
  if (relayed) { // a phone using a public link: the public links are the only ones it can use
    if (relayed.role !== 'control') return res.status(403).json({ ok: false, error: 'Only a control link can share links.' });
    const links = publicLinksFromRequest(relayed.relayRoom, req);
    return res.json({ ok: true, slug: relayed.relayRoom.slug, ...links, controlQr: await qr(links.controlUrl), displayQr: await qr(links.displayUrl), ...(links.viewUrl ? { viewQr: await qr(links.viewUrl) } : {}) });
  }
  const access = auth.resolveSocketAccess(token);
  if (!access || access.role !== 'control') return res.status(403).json({ ok: false, error: 'Only a control link can share links.' });
  const links = buildRoomLinks(shareBaseUrl(req.protocol, req.get('host')), access.room);
  const pub = relayAgent ? relayAgent.status().links[String(access.room.id)] : null;
  res.json({
    ok: true, slug: access.room.slug, ...links, controlQr: await qr(links.controlUrl), displayQr: await qr(links.displayUrl),
    ...(links.viewUrl ? { viewQr: await qr(links.viewUrl) } : {}),
    ...(pub ? { publicControlUrl: pub.controlUrl, publicDisplayUrl: pub.displayUrl, publicControlQr: await qr(pub.controlUrl), publicDisplayQr: await qr(pub.displayUrl) } : {}),
    ...(pub && pub.viewUrl ? { publicViewUrl: pub.viewUrl, publicViewQr: await qr(pub.viewUrl) } : {}),
  });
});

app.post('/api/qr', auth.requireDashboardAuth, async (req, res) => {
  const text = req.body && req.body.text;
  if (typeof text !== 'string' || !text || text.length > 2000) {
    return res.status(400).json({ ok: false, error: 'Missing or invalid "text"' });
  }
  const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.json({ ok: true, svg });
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

app.post('/api/demo', onlineOnly, async (req, res) => {
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

  const links = buildRoomLinks(shareBaseUrl(req.protocol, req.get('host')), room);
  const qr = (text) => QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  const [controlQr, displayQr] = await Promise.all([qr(links.controlUrl), qr(links.displayUrl)]);
  console.log(`🧪 Demo room ${room.slug} (id=${room.id}) created, expires ${new Date(expiresAt).toISOString()}`);
  res.json({ ok: true, ...links, expiresAt, controlQr, displayQr });
});

// Deletes expired demo rooms. Anyone still connected is told the demo has
// ended (control/display show that instead of a generic "invalid link").
// First run of a Local Show Server: a ready-made room so the operator can
// start straight away. Only when the local client has no rooms at all.
function ensureLocalStarterRoom() {
  const client = db.getOrCreateLocalClient();
  if (db.getRoomsForClient(client.id).length) return;
  const room = db.createRoom(client.id, 'Main stage');
  const state = createDefaultTimerState();
  timerRooms.set(String(room.id), state);
  db.writeRoomState(room.id, state);
  console.log('Created a "Main stage" room for this show laptop');
}

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
    const screensShowingRoom = db.listScreensForRoom(room.id);
    db.deleteRoom(room.id);
    screensShowingRoom.forEach((sc) => notifyScreen(sc.id));
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
  // A show laptop has no use for the marketing page: go straight to the rooms.
  if (LOCAL_MODE) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/control', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'control.html'));
});

app.get('/display', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'display.html'));
});

app.get('/screen', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'screen.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// The Companion module package, for Companion's "Import module package". A fixed
// link that always serves whichever version is in public/downloads (keep just
// one there), so Help and the dashboard never need editing for a new release.
// Static file, so it works on a show laptop with no internet.
app.get('/download/companion-module', (req, res) => {
  const dir = path.join(__dirname, 'public', 'downloads');
  let file = null;
  try {
    file = require('fs').readdirSync(dir).filter((f) => /^foxy-presentation-timer-[\d.]+\.tgz$/.test(f)).sort().pop() || null;
  } catch { /* no downloads folder */ }
  if (!file) return res.status(404).send('The Companion module is not included in this build.');
  res.download(path.join(dir, file), file);
});

app.get('/help', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'help.html'));
});

app.get('/try', onlineOnly, (req, res) => {
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
if (LOCAL_MODE) ensureLocalStarterRoom();
// Check in with Foxy Timer Online at startup and every few hours (picks up a
// new trial or an extension; offline is fine), and keep the clock guard current.
if (licence) {
  licence.checkIn();
  setInterval(() => licence.checkIn(), 6 * 60 * 60 * 1000).unref();
  setInterval(() => licence.tickClock(), 60 * 60 * 1000).unref();
}
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

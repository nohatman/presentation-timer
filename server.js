const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const db = require('./db');
const auth = require('./auth');
const { buildRoomLinks } = require('./urls');

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

function broadcastControllerStatus(roomId) {
  io.to(roomId).emit('controllerStatus', { activeControllerSocketId: roomControllers.get(roomId) || null });
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
      timerRooms.set(roomId, { ...createDefaultTimerState(), ...state });
      count++;
    }
    if (count > 0) console.log(`✅ Loaded ${count} room(s) from database`);
  } catch (err) {
    console.error('⚠️  Failed to load rooms state (starting fresh):', err.message);
  }
}

// ============================================

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
    countUp: false,
    showClock: false,
    outputMode: 'timer', // 'timer' | 'clock'
    displayScale: 1.5, // Display size multiplier (0.5 - 2.0)
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
  socket.clientType = role;
  socket.roomId = roomId;

  console.log(`👤 Client ${socket.id} joined room: ${roomId} as ${role}`);

  // Send current state to new client, plus a one-time roomInfo. Every role gets
  // the slug (just a label, not a secret). Only control-role sockets also get
  // both links - a control token grants no way to learn the room's separate
  // display token other than the server telling it. This must NEVER go out via
  // the shared emitState() broadcast (io.to(roomId)), since that reaches
  // display-role sockets too, who must never see the control link.
  const initialState = getRoomState(roomId);
  let roomInfo = { slug: access.room.slug };
  if (role === 'control') {
    const proto = socket.handshake.headers['x-forwarded-proto'] || (socket.handshake.secure ? 'https' : 'http');
    const baseUrl = `${proto}://${socket.handshake.headers.host}`;
    roomInfo = { ...roomInfo, ...buildRoomLinks(baseUrl, access.room) };
  }
  socket.emit('timerState', { ...initialState, serverNow: Date.now(), ...(roomInfo ? { roomInfo } : {}) });

  // Broadcast controller count to all clients in room
  broadcastControllerCount(roomId);

  // Phase 4: claim active-controller status if the slot is empty or its previous
  // holder is no longer connected; otherwise this socket is an observer - it gets
  // told the current status directly rather than triggering a room-wide broadcast,
  // since nothing changed for the sockets already connected.
  if (role === 'control') {
    const currentHolder = roomControllers.get(roomId);
    const holderStillConnected = currentHolder && io.sockets.sockets.get(currentHolder);
    if (!holderStillConnected) {
      roomControllers.set(roomId, socket.id);
      broadcastControllerStatus(roomId);
    } else {
      socket.emit('controllerStatus', { activeControllerSocketId: currentHolder });
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
    roomControllers.set(roomId, socket.id);
    broadcastControllerStatus(roomId);
  });

  // Handle control commands from control panel
  socket.on('startTimer', (data) => {
    if (!requireActiveController()) return;
    const timerState = getRoomState(roomId);
    if (!timerState) return;
    timerState.mode = 'running';
    timerState.startTime = Date.now();
    timerState.pauseTime = null;
    timerState.accumulatedPauseMs = 0;
    if (data.durationMs !== undefined) timerState.durationMs = data.durationMs;
    if (data.speed !== undefined) timerState.speed = data.speed;
    if (data.amberThresholdMs !== undefined) timerState.amberThresholdMs = data.amberThresholdMs;
    if (data.redThresholdMs !== undefined) timerState.redThresholdMs = data.redThresholdMs;
    if (data.durationMs === undefined && data.endAtTarget) {
      timerState.endAtTarget = data.endAtTarget;
      // Compute duration from endAtTarget (supports next day)
      const now = new Date();
      const endTime = new Date(now);
      const [h, m] = data.endAtTarget.split(':');
      endTime.setHours(parseInt(h), parseInt(m), 0, 0);
      if (endTime <= now) {
        endTime.setDate(endTime.getDate() + 1);
      }
      timerState.durationMs = endTime.getTime() - now.getTime();
    }
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
    // Adjust duration, which effectively adjusts remaining for all modes
    const newDuration = Math.max(0, (timerState.durationMs || 0) + Math.trunc(deltaMs));
    timerState.durationMs = newDuration;
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
      timerState.mode = 'running';
      // Accumulate paused duration so elapsed accounts for pauses
      if (timerState.pauseTime) {
        timerState.accumulatedPauseMs += Date.now() - timerState.pauseTime;
      }
      timerState.pauseTime = null;
      emitState(roomId, timerState);
      scheduleSave();
    }
  });

  socket.on('resetTimer', () => {
    if (!requireActiveController()) return;
    const timerState = getRoomState(roomId);
    if (!timerState) return;
    timerState.mode = 'stopped';
    timerState.startTime = null;
    timerState.pauseTime = null;
    timerState.accumulatedPauseMs = 0;
    timerState.endAtTarget = null;
    emitState(roomId, timerState);
    scheduleSave();
  });

  socket.on('updateSettings', (data) => {
    if (!requireActiveController()) return;
    const timerState = getRoomState(roomId);
    if (!timerState) return;
    if (data.durationMs !== undefined) timerState.durationMs = data.durationMs;
    if (data.speed !== undefined) timerState.speed = data.speed;
    if (data.amberThresholdMs !== undefined) timerState.amberThresholdMs = data.amberThresholdMs;
    if (data.redThresholdMs !== undefined) timerState.redThresholdMs = data.redThresholdMs;
    if (data.countUp !== undefined) timerState.countUp = data.countUp;
    if (data.showClock !== undefined) timerState.showClock = data.showClock;
    if (data.displayScale !== undefined) timerState.displayScale = data.displayScale;

    // If setting end-at time, calculate duration (supports next day)
    if (data.durationMs === undefined && data.endAtTarget) {
      const now = new Date();
      const endTime = new Date(now);
      const [hours, minutes] = data.endAtTarget.split(':');
      endTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);
      if (endTime <= now) {
        endTime.setDate(endTime.getDate() + 1);
      }
      timerState.durationMs = endTime.getTime() - now.getTime();
      timerState.endAtTarget = data.endAtTarget;
    }

    emitState(roomId, timerState);
    scheduleSave();
  });

  socket.on('setRundown', (items) => {
    if (!requireActiveController()) return;
    const timerState = getRoomState(roomId);
    if (!timerState) return;
    if (!Array.isArray(items)) return;
    timerState.rundown = items.map(item => ({
      name: String(item.name || '').slice(0, 100),
      durationMs: Math.max(0, Math.floor(Number(item.durationMs) || 0))
    }));
    // Clamp index if items were removed
    if (timerState.rundownIndex >= timerState.rundown.length) {
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

  socket.on('disconnect', () => {
    console.log(`👋 Client ${socket.id} disconnected from room: ${roomId}`);

    // If the departing socket was the active controller, promote another
    // connected control-role socket in this room if one exists, else clear the
    // slot so the next control connection claims it fresh.
    if (socket.clientType === 'control' && roomControllers.get(roomId) === socket.id) {
      let promoted = null;
      const socketsInRoom = io.sockets.adapter.rooms.get(roomId);
      if (socketsInRoom) {
        for (const socketId of socketsInRoom) {
          if (socketId === socket.id) continue;
          const other = io.sockets.sockets.get(socketId);
          if (other && other.clientType === 'control') {
            promoted = socketId;
            break;
          }
        }
      }
      if (promoted) {
        roomControllers.set(roomId, promoted);
      } else {
        roomControllers.delete(roomId);
      }
      broadcastControllerStatus(roomId);
    }

    // Broadcast updated controller count after disconnect
    setTimeout(() => {
      broadcastControllerCount(roomId);
      checkAndCleanupRoom(roomId);
    }, 100);
  });
});

// Helper to broadcast controller count to room
function broadcastControllerCount(roomId) {
  const socketsInRoom = io.sockets.adapter.rooms.get(roomId);
  if (!socketsInRoom) return;

  let controllerCount = 0;
  for (const socketId of socketsInRoom) {
    const socket = io.sockets.sockets.get(socketId);
    if (socket && socket.clientType === 'control') {
      controllerCount++;
    }
  }

  // Emit to all clients in room
  io.to(roomId).emit('controllerCount', { count: controllerCount });
}

// Cleanup empty rooms after a delay
const roomCleanupTimers = new Map();

function checkAndCleanupRoom(roomId) {
  // Clear any existing cleanup timer for this room
  if (roomCleanupTimers.has(roomId)) {
    clearTimeout(roomCleanupTimers.get(roomId));
  }

  // Check if room is empty
  const socketsInRoom = io.sockets.adapter.rooms.get(roomId);
  if (!socketsInRoom || socketsInRoom.size === 0) {
    // Only cleanup rooms that are in 'stopped' mode
    // This prevents configured/paused rooms from being deleted
    const roomState = timerRooms.get(roomId);
    if (roomState && roomState.mode !== 'stopped') {
      console.log(`⏸️  Room ${roomId} is empty but not stopped - keeping it`);
      return;
    }

    // Schedule cleanup after 30 minutes of inactivity
    const timer = setTimeout(() => {
      // Double-check room is still empty and stopped before deleting
      const stillEmpty = !io.sockets.adapter.rooms.get(roomId) || io.sockets.adapter.rooms.get(roomId).size === 0;
      const currentState = timerRooms.get(roomId);
      if (stillEmpty && currentState && currentState.mode === 'stopped') {
        timerRooms.delete(roomId);
        roomControllers.delete(roomId);
        db.deleteRoom(Number(roomId));
        roomCleanupTimers.delete(roomId);
        console.log(`🗑️  Cleaned up empty room: ${roomId}`);
      }
    }, 30 * 60 * 1000); // 30 minutes

    roomCleanupTimers.set(roomId, timer);
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
  // returns null for both cases, so there is nothing here that could leak which.
  const user = await db.verifyUserPassword(email, password);
  if (!user) {
    recordLoginAttempt(ip);
    return res.status(401).json({ ok: false, error: 'Invalid email or password' });
  }

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
  roomControllers.delete(roomId);
  db.deleteRoom(room.id);

  if (roomCleanupTimers.has(roomId)) {
    clearTimeout(roomCleanupTimers.get(roomId));
    roomCleanupTimers.delete(roomId);
  }

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
  timerState.mode = 'running';
  timerState.startTime = Date.now();
  timerState.accumulatedPauseMs = 0;
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
  const pauseDurationMs = Date.now() - timerState.pauseTime;
  timerState.accumulatedPauseMs += pauseDurationMs;
  timerState.mode = 'running';
  timerState.pauseTime = null;
  io.to(roomId).emit('timerState', timerState);
  scheduleSave();
  res.json({ ok: true, roomId, slug: room.slug, clientName: room.client_name, state: timerState });
});

app.post('/api/admin/rooms/:id/reset', ...adminRoomAuth, (req, res) => {
  const { roomId, timerState, room } = req;
  timerState.mode = 'stopped';
  timerState.startTime = null;
  timerState.pauseTime = null;
  timerState.accumulatedPauseMs = 0;
  io.to(roomId).emit('timerState', timerState);
  scheduleSave();
  res.json({ ok: true, roomId, slug: room.slug, clientName: room.client_name, state: timerState });
});

app.delete('/api/admin/rooms/:id', auth.requireDashboardAuth, auth.requirePlatformAdmin, auth.resolveRoomById, (req, res) => {
  const { roomId, room } = req;

  timerRooms.delete(roomId);
  roomControllers.delete(roomId);
  db.deleteRoom(room.id);

  if (roomCleanupTimers.has(roomId)) {
    clearTimeout(roomCleanupTimers.get(roomId));
    roomCleanupTimers.delete(roomId);
  }

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

  timerState.mode = 'running';
  timerState.startTime = Date.now();
  timerState.accumulatedPauseMs = 0;

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

  const pauseDurationMs = Date.now() - timerState.pauseTime;
  timerState.accumulatedPauseMs += pauseDurationMs;
  timerState.mode = 'running';
  timerState.pauseTime = null;

  io.to(roomId).emit('timerState', timerState);
  scheduleSave();

  res.json({ ok: true, roomId: req.params.roomId, state: timerState });
});

// POST reset timer
app.post('/api/rooms/:roomId/reset', ...roomAuth, (req, res) => {
  const { roomId } = req;
  const timerState = req.timerState;

  timerState.mode = 'stopped';
  timerState.startTime = null;
  timerState.pauseTime = null;
  timerState.accumulatedPauseMs = 0;

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
    timerState.durationMs = Math.max(0, timerState.durationMs + ms);
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
  timerState.durationMs = durationMs;

  io.to(roomId).emit('timerState', timerState);
  scheduleSave();

  res.json({ ok: true, roomId: req.params.roomId, state: timerState });
});

// ============================================
// REST API — Rundown navigation
// ============================================

function loadRundownItem(s, index, autoStart) {
  s.rundownIndex = index;
  s.durationMs   = s.rundown[index].durationMs;
  s.startTime    = autoStart ? Date.now() : null;
  s.pauseTime    = null;
  s.accumulatedPauseMs = 0;
  s.endAtTarget  = null;
  s.mode         = autoStart ? 'running' : 'stopped';
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

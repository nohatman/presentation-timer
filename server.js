const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
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

// Timer state - Multi-room support
const timerRooms = new Map();

// ============================================
// Persistence - save/load room state to disk
// ============================================

const PERSISTENCE_FILE = path.join(__dirname, 'rooms.json');
let saveTimeout = null;

function scheduleSave() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(persistRooms, 500);
}

function persistRooms() {
  try {
    const data = {};
    for (const [roomId, state] of timerRooms.entries()) {
      data[roomId] = { ...state };
    }
    fs.writeFileSync(PERSISTENCE_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('⚠️  Failed to save rooms state:', err.message);
  }
}

function loadRooms() {
  try {
    if (fs.existsSync(PERSISTENCE_FILE)) {
      const raw = fs.readFileSync(PERSISTENCE_FILE, 'utf8');
      const data = JSON.parse(raw);
      let count = 0;
      for (const [roomId, state] of Object.entries(data)) {
        // Merge with defaults so any new fields added later are present
        timerRooms.set(roomId, { ...createDefaultTimerState(), ...state });
        console.log(`📂 Restored room: ${roomId} (${state.mode})`);
        count++;
      }
      if (count > 0) console.log(`✅ Loaded ${count} room(s) from disk`);
    }
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
    rundownIndex: -1   // -1 = not in rundown mode
  };
}

// Helper to get or create room state
function getRoomState(roomId) {
  if (!timerRooms.has(roomId)) {
    timerRooms.set(roomId, createDefaultTimerState());
    console.log(`📦 Created new room: ${roomId}`);
  }
  return timerRooms.get(roomId);
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  const roomId = socket.handshake.query.room || 'default';
  const clientType = socket.handshake.query.type || 'unknown'; // 'control' or 'display'
  socket.join(roomId);

  // Store client type on socket for later reference
  socket.clientType = clientType;
  socket.roomId = roomId;

  console.log(`👤 Client ${socket.id} joined room: ${roomId} as ${clientType}`);

  // Send current state to new client
  const timerState = getRoomState(roomId);
  socket.emit('timerState', timerState);

  // Broadcast controller count to all clients in room
  broadcastControllerCount(roomId);

  // Handle control commands from control panel
  socket.on('startTimer', (data) => {
    const timerState = getRoomState(roomId);
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

    io.to(roomId).emit('timerState', timerState);
    scheduleSave();
  });

  // Explicit output mode control (overrides showClock convenience)
  socket.on('setOutputMode', (mode) => {
    const timerState = getRoomState(roomId);
    if (mode === 'timer' || mode === 'clock') {
      timerState.outputMode = mode;
      // mirror to showClock for backward compatibility on clients
      timerState.showClock = (mode === 'clock');
      io.to(roomId).emit('timerState', timerState);
      scheduleSave();
    }
  });

  // Nudge timer by deltaMs (positive to add time, negative to subtract)
  socket.on('nudgeTimer', (deltaMs) => {
    const timerState = getRoomState(roomId);
    if (typeof deltaMs !== 'number' || !isFinite(deltaMs)) return;
    // Adjust duration, which effectively adjusts remaining for all modes
    const newDuration = Math.max(0, (timerState.durationMs || 0) + Math.trunc(deltaMs));
    timerState.durationMs = newDuration;
    io.to(roomId).emit('timerState', timerState);
    scheduleSave();
  });

  socket.on('pauseTimer', () => {
    const timerState = getRoomState(roomId);
    if (timerState.mode === 'running') {
      timerState.mode = 'paused';
      timerState.pauseTime = Date.now();
      io.to(roomId).emit('timerState', timerState);
      scheduleSave();
    }
  });

  socket.on('resumeTimer', () => {
    const timerState = getRoomState(roomId);
    if (timerState.mode === 'paused') {
      timerState.mode = 'running';
      // Accumulate paused duration so elapsed accounts for pauses
      if (timerState.pauseTime) {
        timerState.accumulatedPauseMs += Date.now() - timerState.pauseTime;
      }
      timerState.pauseTime = null;
      io.to(roomId).emit('timerState', timerState);
      scheduleSave();
    }
  });

  socket.on('resetTimer', () => {
    const timerState = getRoomState(roomId);
    timerState.mode = 'stopped';
    timerState.startTime = null;
    timerState.pauseTime = null;
    timerState.accumulatedPauseMs = 0;
    timerState.endAtTarget = null;
    io.to(roomId).emit('timerState', timerState);
    scheduleSave();
  });

  socket.on('updateSettings', (data) => {
    const timerState = getRoomState(roomId);
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

    io.to(roomId).emit('timerState', timerState);
    scheduleSave();
  });

  socket.on('setRundown', (items) => {
    const timerState = getRoomState(roomId);
    if (!Array.isArray(items)) return;
    timerState.rundown = items.map(item => ({
      name: String(item.name || '').slice(0, 100),
      durationMs: Math.max(0, Math.floor(Number(item.durationMs) || 0))
    }));
    // Clamp index if items were removed
    if (timerState.rundownIndex >= timerState.rundown.length) {
      timerState.rundownIndex = timerState.rundown.length - 1;
    }
    io.to(roomId).emit('timerState', timerState);
    scheduleSave();
  });

  socket.on('goToRundown', (data) => {
    const timerState = getRoomState(roomId);
    const index = parseInt(data.index);
    if (index < 0 || index >= timerState.rundown.length) return;
    loadRundownItem(timerState, index, !!data.autoStart);
    io.to(roomId).emit('timerState', timerState);
    scheduleSave();
  });

  socket.on('disconnect', () => {
    console.log(`👋 Client ${socket.id} disconnected from room: ${roomId}`);
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
        roomCleanupTimers.delete(roomId);
        console.log(`🗑️  Cleaned up empty room: ${roomId}`);
        scheduleSave();
      }
    }, 30 * 60 * 1000); // 30 minutes

    roomCleanupTimers.set(roomId, timer);
  }
}

// Timer tick - send updates every second for all running timers
setInterval(() => {
  timerRooms.forEach((timerState, roomId) => {
    if (timerState.mode === 'running') {
      io.to(roomId).emit('timerState', timerState);
    }
  });
}, 1000);

// API endpoint to get active rooms
app.get('/api/rooms', (req, res) => {
  const rooms = [];
  for (const [roomId, state] of timerRooms.entries()) {
    // Get connection count for this room
    const socketsInRoom = io.sockets.adapter.rooms.get(roomId);
    const connectionCount = socketsInRoom ? socketsInRoom.size : 0;

    // Calculate remaining time and overtime
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

    rooms.push({
      id: roomId,
      mode: state.mode,
      connections: connectionCount,
      remainingMs: Math.floor(remainingMs),
      overMs: Math.floor(overMs),
      outputMode: state.outputMode,
      countUp: state.countUp || false,
      amberThresholdMs: state.amberThresholdMs,
      redThresholdMs: state.redThresholdMs
    });
  }

  res.json(rooms);
});

// Delete room endpoint
app.delete('/api/rooms/:roomId', (req, res) => {
  const roomId = req.params.roomId;

  if (!timerRooms.has(roomId)) {
    return res.status(404).json({ error: 'Room not found' });
  }

  // Delete the room state
  timerRooms.delete(roomId);

  // Clear any pending cleanup timer
  if (roomCleanupTimers.has(roomId)) {
    clearTimeout(roomCleanupTimers.get(roomId));
    roomCleanupTimers.delete(roomId);
  }

  // Disconnect all sockets in the room
  const socketsInRoom = io.sockets.adapter.rooms.get(roomId);
  if (socketsInRoom) {
    for (const socketId of socketsInRoom) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        socket.disconnect(true);
      }
    }
  }

  console.log(`🗑️  Manually deleted room: ${roomId}`);
  scheduleSave();
  res.json({ success: true, message: 'Room deleted' });
});

// ============================================
// REST API for Bitfocus Companion
// ============================================

// GET pre-computed display values optimised for Companion button feedback
app.get('/api/rooms/:roomId/companion', (req, res) => {
  const { roomId } = req.params;
  const s = getRoomState(roomId);

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
app.get('/api/rooms/:roomId/state', (req, res) => {
  const { roomId } = req.params;
  const timerState = getRoomState(roomId);

  res.json({
    ok: true,
    roomId,
    state: timerState
  });
});

// POST start timer
app.post('/api/rooms/:roomId/start', (req, res) => {
  const { roomId } = req.params;
  const timerState = getRoomState(roomId);

  if (timerState.mode === 'running') {
    return res.json({
      ok: false,
      error: 'Timer is already running'
    });
  }

  // Start timer logic (same as Socket.IO handler)
  timerState.mode = 'running';
  timerState.startTime = Date.now();
  timerState.accumulatedPauseMs = 0;

  // Broadcast to all clients in the room
  io.to(roomId).emit('timerState', timerState);
  scheduleSave();

  res.json({
    ok: true,
    roomId,
    state: timerState
  });
});

// POST pause timer
app.post('/api/rooms/:roomId/pause', (req, res) => {
  const { roomId } = req.params;
  const timerState = getRoomState(roomId);

  if (timerState.mode !== 'running') {
    return res.json({
      ok: false,
      error: 'Timer is not running'
    });
  }

  // Pause timer logic (same as Socket.IO handler)
  timerState.mode = 'paused';
  timerState.pauseTime = Date.now();

  // Broadcast to all clients in the room
  io.to(roomId).emit('timerState', timerState);
  scheduleSave();

  res.json({
    ok: true,
    roomId,
    state: timerState
  });
});

// POST resume timer
app.post('/api/rooms/:roomId/resume', (req, res) => {
  const { roomId } = req.params;
  const timerState = getRoomState(roomId);

  if (timerState.mode !== 'paused') {
    return res.json({
      ok: false,
      error: 'Timer is not paused'
    });
  }

  // Resume timer logic (same as Socket.IO handler)
  const pauseDurationMs = Date.now() - timerState.pauseTime;
  timerState.accumulatedPauseMs += pauseDurationMs;
  timerState.mode = 'running';
  timerState.pauseTime = null;

  // Broadcast to all clients in the room
  io.to(roomId).emit('timerState', timerState);
  scheduleSave();

  res.json({
    ok: true,
    roomId,
    state: timerState
  });
});

// POST reset timer
app.post('/api/rooms/:roomId/reset', (req, res) => {
  const { roomId } = req.params;
  const timerState = getRoomState(roomId);

  // Reset timer logic (same as Socket.IO handler)
  timerState.mode = 'stopped';
  timerState.startTime = null;
  timerState.pauseTime = null;
  timerState.accumulatedPauseMs = 0;

  // Broadcast to all clients in the room
  io.to(roomId).emit('timerState', timerState);
  scheduleSave();

  res.json({
    ok: true,
    roomId,
    state: timerState
  });
});

// POST nudge timer (adjust time by +/- milliseconds)
app.post('/api/rooms/:roomId/nudge', (req, res) => {
  const { roomId } = req.params;
  const { ms } = req.body;

  if (typeof ms !== 'number') {
    return res.json({
      ok: false,
      error: 'Missing or invalid "ms" in request body'
    });
  }

  const timerState = getRoomState(roomId);

  // Nudge logic (same as Socket.IO handler)
  if (timerState.mode === 'running') {
    timerState.startTime -= ms;
  } else if (timerState.mode === 'paused') {
    timerState.pauseTime -= ms;
  } else {
    timerState.durationMs = Math.max(0, timerState.durationMs + ms);
  }

  // Broadcast to all clients in the room
  io.to(roomId).emit('timerState', timerState);
  scheduleSave();

  res.json({
    ok: true,
    roomId,
    state: timerState
  });
});

// POST set duration (update preset duration)
app.post('/api/rooms/:roomId/set-duration', (req, res) => {
  const { roomId } = req.params;
  const { durationMs } = req.body;

  if (typeof durationMs !== 'number' || durationMs < 0) {
    return res.json({
      ok: false,
      error: 'Missing or invalid "durationMs" in request body'
    });
  }

  const timerState = getRoomState(roomId);

  // Set duration logic
  timerState.durationMs = durationMs;

  // Broadcast to all clients in the room
  io.to(roomId).emit('timerState', timerState);
  scheduleSave();

  res.json({
    ok: true,
    roomId,
    state: timerState
  });
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
app.post('/api/rooms/:roomId/rundown/prev', (req, res) => {
  const { roomId } = req.params;
  const s = getRoomState(roomId);
  if (!s.rundown.length) return res.json({ ok: false, error: 'No rundown configured' });
  const idx = s.rundownIndex <= 0 ? 0 : s.rundownIndex - 1;
  if (idx === s.rundownIndex && s.rundownIndex === 0) return res.json({ ok: false, error: 'Already at first item' });
  loadRundownItem(s, idx, false);
  io.to(roomId).emit('timerState', s);
  scheduleSave();
  res.json({ ok: true, roomId, rundownIndex: idx });
});

// POST /api/rooms/:roomId/rundown/next — load next item (stops timer)
app.post('/api/rooms/:roomId/rundown/next', (req, res) => {
  const { roomId } = req.params;
  const s = getRoomState(roomId);
  if (!s.rundown.length) return res.json({ ok: false, error: 'No rundown configured' });
  const idx = s.rundownIndex < 0 ? 0 : s.rundownIndex + 1;
  if (idx >= s.rundown.length) return res.json({ ok: false, error: 'Already at last item' });
  loadRundownItem(s, idx, false);
  io.to(roomId).emit('timerState', s);
  scheduleSave();
  res.json({ ok: true, roomId, rundownIndex: idx });
});

// POST /api/rooms/:roomId/rundown/take — start the currently loaded item
// If no item is loaded (rundownIndex === -1), loads and starts the first item.
app.post('/api/rooms/:roomId/rundown/take', (req, res) => {
  const { roomId } = req.params;
  const s = getRoomState(roomId);
  if (!s.rundown.length) return res.json({ ok: false, error: 'No rundown configured' });
  const idx = s.rundownIndex < 0 ? 0 : s.rundownIndex;
  loadRundownItem(s, idx, true);
  io.to(roomId).emit('timerState', s);
  scheduleSave();
  res.json({ ok: true, roomId, rundownIndex: idx });
});

// POST /api/rooms/:roomId/rundown/goto — load a specific item by 0-based index
// Body: { index: number, autoStart?: boolean }
app.post('/api/rooms/:roomId/rundown/goto', (req, res) => {
  const { roomId } = req.params;
  const { index, autoStart = false } = req.body;
  if (!Number.isInteger(index)) return res.json({ ok: false, error: 'Missing or invalid "index" (0-based integer)' });
  const s = getRoomState(roomId);
  if (index < 0 || index >= s.rundown.length) return res.json({ ok: false, error: `Index out of range (0–${s.rundown.length - 1})` });
  loadRundownItem(s, index, autoStart);
  io.to(roomId).emit('timerState', s);
  scheduleSave();
  res.json({ ok: true, roomId, rundownIndex: index });
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

// Load persisted rooms before starting
loadRooms();

// Start server
const PORT = process.env.PORT || 3000;
console.log(`Starting server on port ${PORT}...`);

server.listen(PORT, () => {
  console.log(`\n✅ Presentation Timer server running successfully!`);
  console.log(`📱 Control panel: http://localhost:${PORT}/control`);
  console.log(`🖥️  Display: http://localhost:${PORT}/display`);
  console.log(`📊 Dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`🏠 Home: http://localhost:${PORT}/`);
  console.log(`\n💡 Tip: Add ?room=yourname to create separate timers`);
  console.log(`   Example: http://localhost:${PORT}/control?room=presentation1\n`);
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

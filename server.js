const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

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
    outputMode: 'timer' // 'timer' | 'clock'
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
  });

  // Explicit output mode control (overrides showClock convenience)
  socket.on('setOutputMode', (mode) => {
    const timerState = getRoomState(roomId);
    if (mode === 'timer' || mode === 'clock') {
      timerState.outputMode = mode;
      // mirror to showClock for backward compatibility on clients
      timerState.showClock = (mode === 'clock');
      io.to(roomId).emit('timerState', timerState);
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
  });

  socket.on('pauseTimer', () => {
    const timerState = getRoomState(roomId);
    if (timerState.mode === 'running') {
      timerState.mode = 'paused';
      timerState.pauseTime = Date.now();
      io.to(roomId).emit('timerState', timerState);
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
  });

  socket.on('updateSettings', (data) => {
    const timerState = getRoomState(roomId);
    if (data.durationMs !== undefined) timerState.durationMs = data.durationMs;
    if (data.speed !== undefined) timerState.speed = data.speed;
    if (data.amberThresholdMs !== undefined) timerState.amberThresholdMs = data.amberThresholdMs;
    if (data.redThresholdMs !== undefined) timerState.redThresholdMs = data.redThresholdMs;
    if (data.countUp !== undefined) timerState.countUp = data.countUp;
    if (data.showClock !== undefined) timerState.showClock = data.showClock;

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
    
    // Calculate remaining time
    let remainingMs = 0;
    if (state.mode === 'running') {
      const elapsed = (Date.now() - state.startTime - state.accumulatedPauseMs) * state.speed;
      remainingMs = Math.max(0, state.durationMs - elapsed);
    } else if (state.mode === 'paused') {
      const elapsed = (state.pauseTime - state.startTime - state.accumulatedPauseMs) * state.speed;
      remainingMs = Math.max(0, state.durationMs - elapsed);
    } else {
      remainingMs = state.durationMs;
    }
    
    rooms.push({
      id: roomId,
      mode: state.mode,
      connections: connectionCount,
      remainingMs: Math.floor(remainingMs),
      outputMode: state.outputMode
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
  res.json({ success: true, message: 'Room deleted' });
});

// ============================================
// REST API for Bitfocus Companion
// ============================================

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
  
  res.json({
    ok: true,
    roomId,
    state: timerState
  });
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

// Start server
const PORT = process.env.PORT || 3000;
console.log(`Starting server on port ${PORT}...`);

server.listen(PORT, () => {
  console.log(`\n✅ Presentation Timer server running successfully!`);
  console.log(`📱 Control panel: http://localhost:${PORT}/control`);
  console.log(`🖥️  Display: http://localhost:${PORT}/display`);
  console.log(`� Dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`�🏠 Home: http://localhost:${PORT}/`);
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

// Graceful shutdown
process.on('SIGINT', () => {
  console.log(`\n\n👋 Shutting down server gracefully...`);
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log(`\n\n👋 Shutting down server gracefully...`);
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

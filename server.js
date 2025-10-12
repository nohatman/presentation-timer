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

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Timer state - single room for now
let timerState = {
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
  showClock: false
};

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Send current state to new client
  socket.emit('timerState', timerState);

  // Handle control commands from control panel
  socket.on('startTimer', (data) => {
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

    io.emit('timerState', timerState);
  });

  socket.on('pauseTimer', () => {
    if (timerState.mode === 'running') {
      timerState.mode = 'paused';
      timerState.pauseTime = Date.now();
      io.emit('timerState', timerState);
    }
  });

  socket.on('resumeTimer', () => {
    if (timerState.mode === 'paused') {
      timerState.mode = 'running';
      // Accumulate paused duration so elapsed accounts for pauses
      if (timerState.pauseTime) {
        timerState.accumulatedPauseMs += Date.now() - timerState.pauseTime;
      }
      timerState.pauseTime = null;
      io.emit('timerState', timerState);
    }
  });

  socket.on('resetTimer', () => {
    timerState.mode = 'stopped';
    timerState.startTime = null;
    timerState.pauseTime = null;
    timerState.accumulatedPauseMs = 0;
    timerState.endAtTarget = null;
    io.emit('timerState', timerState);
  });

  socket.on('updateSettings', (data) => {
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

    io.emit('timerState', timerState);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Timer tick - send updates every second
setInterval(() => {
  if (timerState.mode === 'running') {
    io.emit('timerState', timerState);
  }
}, 1000);

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

// Start server
const PORT = process.env.PORT || 3000;
console.log(`Starting server on port ${PORT}...`);
server.listen(PORT, () => {
  console.log(`✅ Presentation Timer server running successfully!`);
  console.log(`📱 Control panel: http://localhost:${PORT}/control`);
  console.log(`🖥️  Display: http://localhost:${PORT}/display`);
  console.log(`🏠 Home: http://localhost:${PORT}/`);
});

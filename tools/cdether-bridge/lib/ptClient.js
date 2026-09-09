'use strict';

// Read-only Presentation Timer subscription.
//
// Connects with the room's DISPLAY token as the sole credential. The server
// (auth.resolveSocketAccess) derives role='display' from which token column
// matched; every mutation handler in server.js is gated on
// socket.clientType === 'control', so a display-token socket is structurally
// incapable of starting/pausing/resetting the timer. This client also never
// emits anything to the server.
//
// Events emitted by this wrapper:
//   'connecting'                      a (re)connection attempt has begun
//   'connected'                       socket connected (state not yet known)
//   'state'    (timerState, offsetMs) fresh authoritative state received
//   'disconnected' ({ reason, intentional, serverInitiated })
//   'connectError' ({ err, kind })    transport failure; kind: 'server-unreachable' | 'unknown'
//   'fatal'    (err)                  token rejected - not recoverable

const { EventEmitter } = require('node:events');
const { io } = require('socket.io-client');

function classifyConnectError(err) {
  const msg = String((err && err.message) || err || '').toLowerCase();
  if (
    msg.includes('xhr poll error') ||
    msg.includes('websocket error') ||
    msg.includes('timeout') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('eai_again') ||
    msg.includes('network') ||
    msg.includes('failed to fetch')
  ) {
    return 'server-unreachable';
  }
  return 'unknown';
}

class PtClient extends EventEmitter {
  constructor({ serverUrl, displayToken }) {
    super();
    this.serverUrl = serverUrl;
    this.displayToken = displayToken;
    this.socket = null;
    this.clockOffsetMs = 0;   // serverNow - Date.now(), from the latest state
    this.lastState = null;    // cleared on disconnect; repopulated on fresh state
    this._stopping = false;   // set by stop() so the next 'disconnect' is intentional
    this._fatal = false;      // set on authError - terminal, suppresses further noise
  }

  start() {
    this._stopping = false;
    this._fatal = false;
    this.socket = io(this.serverUrl, {
      auth: { token: this.displayToken },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelayMax: 5000,
      timeout: 10000,
    });

    this.emit('connecting');

    this.socket.on('connect', () => this.emit('connected'));

    this.socket.io.on('reconnect_attempt', () => {
      if (!this._stopping) this.emit('connecting');
    });

    this.socket.on('timerState', (state) => {
      if (state && typeof state.serverNow === 'number') {
        this.clockOffsetMs = state.serverNow - Date.now();
      }
      this.lastState = state;
      this.emit('state', state, this.clockOffsetMs);
    });

    // server.js emits this then disconnects the socket. Reconnecting cannot fix
    // a bad/expired/suspended token, so treat it as fatal.
    this.socket.on('authError', ({ message } = {}) => {
      this._fatal = true;
      this.emit('fatal', new Error(`Display token rejected: ${message || 'invalid or expired link'}`));
    });

    this.socket.on('disconnect', (reason) => {
      this.lastState = null;
      if (this._fatal) return; // authError already fired; the disconnect it triggers is noise
      // 'io server disconnect' = the server deliberately booted us (room
      // deleted, tokens regenerated, client suspended). socket.io will NOT
      // auto-reconnect in that case, so the engine has to drive retries.
      const serverInitiated = reason === 'io server disconnect';
      this.emit('disconnected', {
        reason,
        intentional: this._stopping,
        serverInitiated,
      });
    });

    this.socket.on('connect_error', (err) => {
      if (this._stopping || this._fatal) return;
      this.emit('connectError', { err, kind: classifyConnectError(err) });
    });
  }

  /** Manual reconnection - needed after an 'io server disconnect'. */
  reconnect() {
    if (this._stopping || this._fatal || !this.socket) return;
    this.emit('connecting');
    this.socket.connect();
  }

  /** Intentional shutdown. The resulting 'disconnect' is flagged intentional. */
  stop() {
    if (!this.socket) return;
    this._stopping = true;
    this.socket.removeAllListeners();
    this.socket.io.removeAllListeners();
    this.socket.disconnect();
    this.socket = null;
    this.lastState = null;
  }
}

module.exports = { PtClient, classifyConnectError };

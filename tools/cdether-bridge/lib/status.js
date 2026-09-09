'use strict';

// Connected / Output / Error status state machine.
//
// Pure logic: no timers, no I/O. The engine calls the setters; anything that
// wants to display status listens for 'change' and reads the immutable
// snapshot. Because the physical display CANNOT be blanked once connectivity is
// lost (frame-timeout test, 2026-09-09), an honest status surface is the
// primary safety mechanism, not a fail-dark trick.

const { EventEmitter } = require('node:events');

const PT_STATES = new Set([
  'disconnected',      // not connected, not trying (initial, or after dispose)
  'connecting',        // socket attempting / reconnecting
  'connected',         // subscribed, authoritative timerState in hand
  'auth-failed',       // token rejected - fatal
  'server-unreachable',// transport cannot reach the server
  'room-unavailable',  // connected but the room is gone / client suspended
]);

const OUTPUT_STATES = new Set([
  'stopped',     // operator has not started, or pressed Stop
  'running',     // operator wants output; frames flow while PT is 'connected'
  'send-error',  // last UDP send failed (NIC down, etc.)
]);

const PT_ERROR = new Set(['auth-failed', 'room-unavailable']);
const PT_TRANSIENT = new Set(['disconnected', 'connecting', 'server-unreachable']);

class StatusModel extends EventEmitter {
  constructor() {
    super();
    const now = Date.now();
    this._pt = { state: 'disconnected', room: null, since: now, detail: null };
    this._output = { state: 'stopped', fps: 0, lastFrame: null, since: now, detail: null };
    this._lastSendOk = null; // null = nothing sent yet
    this._overall = { state: 'idle', reason: 'Idle - output stopped', since: now };
    this._recompute(now, /* silent */ true);
  }

  // ---- setters (called by the engine) ----

  setPt(state, { room, detail } = {}) {
    if (!PT_STATES.has(state)) throw new Error(`Unknown PT state: ${state}`);
    if (state === 'connected') this._everConnected = true;
    const changed = state !== this._pt.state;
    this._pt = {
      state,
      room: room !== undefined ? room : this._pt.room,
      since: changed ? Date.now() : this._pt.since,
      detail: detail !== undefined ? detail : this._pt.detail,
    };
    this._recompute(Date.now());
  }

  setOutput(state, { fps, lastFrame, detail } = {}) {
    if (!OUTPUT_STATES.has(state)) throw new Error(`Unknown output state: ${state}`);
    const changed = state !== this._output.state;
    this._output = {
      state,
      fps: fps !== undefined ? fps : this._output.fps,
      lastFrame: lastFrame !== undefined ? lastFrame : this._output.lastFrame,
      since: changed ? Date.now() : this._output.since,
      detail: detail !== undefined ? detail : this._output.detail,
    };
    if (state === 'stopped') this._lastSendOk = null;
    this._recompute(Date.now());
  }

  /** Record the outcome of the most recent UDP send. */
  noteSend(ok, { reason } = {}) {
    this._lastSendOk = !!ok;
    if (!ok) {
      this._output = { ...this._output, state: 'send-error', detail: reason || 'send failed' };
    } else if (this._output.state === 'send-error') {
      this._output = { ...this._output, state: 'running', detail: null };
    }
    this._recompute(Date.now());
  }

  // ---- derivation ----

  _deriveOverall() {
    const pt = this._pt.state;
    const out = this._output.state;

    if (PT_ERROR.has(pt)) {
      return {
        state: 'error',
        reason: pt === 'auth-failed'
          ? 'Presentation Timer rejected the display token'
          : 'Room unavailable (deleted, or the client is suspended)',
      };
    }
    if (out === 'send-error') {
      return {
        state: 'error',
        reason: `CDEther output failed: ${this._output.detail || 'the selected network adapter is not sending'}`,
      };
    }
    if (out === 'stopped') {
      return { state: 'idle', reason: 'Output stopped' };
    }
    // output === 'running'
    if (pt === 'connected') {
      return {
        state: 'live',
        reason: this._pt.room
          ? `Live - following room "${this._pt.room}"`
          : 'Live',
      };
    }
    // output running but PT not connected.
    if (PT_TRANSIENT.has(pt)) {
      if (!this._everConnected) {
        return { state: 'degraded', reason: 'Output on - connecting to the Presentation Timer...' };
      }
      // we were live and lost PT: cannot reach the hardware and cannot blank it.
      return {
        state: 'degraded',
        reason: 'Presentation Timer connection lost - the physical display is holding its last value; output will resume automatically when the connection returns',
      };
    }
    return { state: 'degraded', reason: 'Degraded' };
  }

  _recompute(now, silent = false) {
    const next = this._deriveOverall();
    if (next.state !== this._overall.state || next.reason !== this._overall.reason) {
      this._overall = {
        state: next.state,
        reason: next.reason,
        since: next.state !== this._overall.state ? now : this._overall.since,
      };
    }
    // Emit only when something a listener would care about actually changed.
    // State transitions only - live detail (fps, lastFrame) is read from
    // snapshot() or the engine's 'frame' events, not signalled here.
    const sig = JSON.stringify([
      this._pt.state, this._pt.room,
      this._output.state,
      this._overall.state, this._overall.reason,
    ]);
    if (silent) { this._sig = sig; return; }
    if (sig !== this._sig) {
      this._sig = sig;
      this.emit('change', this.snapshot());
    }
  }

  // ---- snapshot ----

  snapshot() {
    return Object.freeze({
      pt: Object.freeze({ ...this._pt }),
      output: Object.freeze({ ...this._output }),
      overall: Object.freeze({ ...this._overall }),
      lastSendOk: this._lastSendOk,
    });
  }
}

module.exports = { StatusModel, PT_STATES, OUTPUT_STATES };

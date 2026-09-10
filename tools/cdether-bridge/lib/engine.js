'use strict';

// Bridge orchestration. Owns the 1 Hz output loop, the latest authoritative
// timerState, and Start/Stop of output. Uses the injected pieces so it can be
// unit-tested with fakes:
//
//   new BridgeEngine({ ptClient, sender, status, log, deriveFrame, options })
//
// Failure semantics (matches the 2026-09-09 frame-timeout hardware test):
//   * intentional Stop / dispose  -> send ONE 0x04 OFF, then cease transmitting
//   * unexpected PT loss / UDP error / NIC down -> cease transmitting, report
//     degraded; do NOT attempt an OFF (it cannot reach disconnected hardware)
//   * on reconnect -> wait for a fresh authoritative timerState, then resume at
//     the correct current value
//   * auth/token failure -> best-effort OFF while the path still exists, then fatal
//   * clock mode / overlay message -> OFF each tick (path is up; physically tested)
//
// No supervisor process. No independent countdown - every frame is a function
// of the latest authoritative state + server clock offset + wall clock.

const { EventEmitter } = require('node:events');
const { encodeFrame, describeFrame, OFF_FRAME } = require('./cdether');
const { buildBridgeStatusPayload } = require('./reporter');

const SERVER_INITIATED_RETRY_MS = 15000;
const HEARTBEAT_INTERVAL_MS = 10000; // P2.1: unconditional keepalive, on top of change-driven reports

class BridgeEngine extends EventEmitter {
  constructor({ ptClient, sender, status, log, deriveFrame, options = {} }) {
    super();
    this.pt = ptClient;
    this.sender = sender;
    this.status = status;
    this.log = log;
    this.deriveFrame = deriveFrame;
    this.frameIntervalMs = options.frameIntervalMs || 1000;
    this.idleBehaviour = options.idleBehaviour || 'duration';
    this.serverRetryMs = options.serverRetryMs || SERVER_INITIATED_RETRY_MS;

    // P2.1: bridge -> Presentation Timer status heartbeat, riding the same
    // read-only display-token connection (see lib/ptClient.js sendStatus()).
    this.bridgeId = options.bridgeId || null;
    this.bridgeVersion = options.bridgeVersion || null;
    this.getInterfaceName = typeof options.getInterfaceName === 'function' ? options.getInterfaceName : () => null;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs || HEARTBEAT_INTERVAL_MS;
    this._heartbeatTimer = null;

    this._outputActive = false;   // operator intent: Start pressed, Stop not
    this._ptConnected = false;    // socket up AND authoritative state in hand
    this._tick = null;
    this._sending = false;
    this._sendTimes = [];         // rolling window for actual fps
    this._retryTimer = null;
    this._disposed = false;
    this._fatalled = false;
    this._inflight = null;

    this.status.on('change', (snap) => {
      this.emit('status', snap);
      this._reportStatus();
    });
    this._wirePt();
  }

  // ---- lifecycle ----

  /** Begin the connection. Output is NOT started until start() is called. */
  connect() {
    this.pt.start();
    if (!this._heartbeatTimer) {
      this._heartbeatTimer = setInterval(() => this._reportStatus(), this.heartbeatIntervalMs);
      if (this._heartbeatTimer.unref) this._heartbeatTimer.unref();
    }
  }

  /**
   * P2.1: report the current status snapshot to the Presentation Timer over
   * the existing read-only connection. Called on every StatusModel 'change'
   * and on a fixed interval regardless of change, so a steady state (e.g.
   * "Live" with nothing transitioning) still refreshes the server's
   * heartbeat clock. Silently does nothing while disconnected - the next
   * successful heartbeat naturally catches the server up.
   */
  _reportStatus() {
    if (!this.pt || typeof this.pt.sendStatus !== 'function') return;
    const payload = buildBridgeStatusPayload(this.status.snapshot(), {
      bridgeId: this.bridgeId,
      bridgeVersion: this.bridgeVersion,
      interfaceName: this.getInterfaceName(),
    });
    this.pt.sendStatus(payload);
  }

  /** Operator: Start Output. */
  start() {
    if (this._disposed || this._outputActive) return;
    this._outputActive = true;
    this.status.setOutput('running', { fps: 0 });
    this._log('info', 'Output started');
    if (!this._tick) {
      this._tick = setInterval(() => this._onTick(), this.frameIntervalMs);
      if (this._tick.unref) this._tick.unref();
    }
    // Send an immediate frame if we already have state.
    this._onTick();
  }

  /**
   * Operator: Stop Output (intentional). Sends ONE OFF frame, then ceases.
   * The PT subscription stays up so status remains truthful.
   */
  async stop() {
    if (!this._outputActive) return;
    this._outputActive = false;
    this._clearTick();
    if (this._inflight) { try { await this._inflight; } catch { /* ignore */ } }
    this.status.setOutput('stopped');
    await this._sendOff('output stopped');
    this._log('info', 'Output stopped - sent OFF');
  }

  /** Full teardown. Intentional -> best-effort OFF if output was active. */
  async dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._clearTick();
    if (this._retryTimer) { clearInterval(this._retryTimer); this._retryTimer = null; }
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
    const wasActive = this._outputActive;
    this._outputActive = false;
    if (this._inflight) { try { await this._inflight; } catch { /* ignore */ } }
    if (wasActive) await this._sendOff('shutdown');
    this.pt.stop();
    this.status.setPt('disconnected');
    this.status.setOutput('stopped');
    if (this.sender && typeof this.sender.close === 'function') {
      try { await this.sender.close(); } catch { /* ignore */ }
    }
  }

  get outputActive() { return this._outputActive; }
  get snapshot() { return this.status.snapshot(); }

  // ---- PT wiring ----

  _wirePt() {
    this.pt.on('connecting', () => {
      this._ptConnected = false;
      this.status.setPt('connecting');
    });

    this.pt.on('connected', () => {
      // socket up but no authoritative state yet - still "connecting" to us
      this.status.setPt('connecting');
      this._log('info', 'Connected to Presentation Timer - awaiting authoritative timerState');
    });

    this.pt.on('state', (state) => {
      const firstState = !this._ptConnected;
      this._ptConnected = true;
      if (this._retryTimer) { clearInterval(this._retryTimer); this._retryTimer = null; }
      const room = state && state.roomInfo && state.roomInfo.slug ? state.roomInfo.slug : this.status.snapshot().pt.room;
      this.status.setPt('connected', { room });
      if (firstState) {
        this._log('info', `Subscribed read-only to room "${room || '(unknown)'}" | clock offset ${this.pt.clockOffsetMs} ms`);
        if (this._outputActive) this._onTick(); // resume immediately at the correct value
      }
    });

    this.pt.on('connectError', ({ err, kind }) => {
      if (kind === 'server-unreachable') this.status.setPt('server-unreachable', { detail: String(err && err.message || err) });
      this._log('warn', `Cannot reach Presentation Timer: ${err && err.message || err} (retrying)`, { throttleKey: 'connectError' });
    });

    this.pt.on('disconnected', ({ reason, intentional, serverInitiated }) => {
      this._ptConnected = false;
      if (intentional || this._fatalled) return; // dispose()/stop()/fatal drive status directly
      if (serverInitiated) {
        this.status.setPt('room-unavailable', { detail: reason });
        this._log('error', 'Presentation Timer closed the connection (room deleted, tokens regenerated, or client suspended) - retrying periodically');
        this._startServerInitiatedRetry();
      } else {
        this.status.setPt('disconnected', { detail: reason });
        this._log('warn', `Disconnected from Presentation Timer (${reason}) - output ceased; the physical display is holding its last value; will resume automatically`);
      }
      // NOTE: deliberately no OFF frame here - it cannot reach the hardware.
    });

    this.pt.on('fatal', async (err) => {
      this._fatalled = true;
      this._clearTick();
      if (this._retryTimer) { clearInterval(this._retryTimer); this._retryTimer = null; }
      this._outputActive = false;
      this.status.setPt('auth-failed', { detail: err.message });
      this._log('error', err.message);
      // The socket is usually still up at this instant (server closes it right
      // after authError), so one OFF has a real chance of landing.
      await this._sendOff('auth failure (best effort)');
      this.emit('fatal', err);
    });
  }

  _startServerInitiatedRetry() {
    if (this._retryTimer || this._disposed) return;
    this._retryTimer = setInterval(() => {
      if (this._disposed) return;
      this._log('info', 'Retrying Presentation Timer connection...');
      this.pt.reconnect();
    }, this.serverRetryMs);
    if (this._retryTimer.unref) this._retryTimer.unref();
  }

  // ---- output loop ----

  async _onTick() {
    if (!this._outputActive || this._sending) return;
    if (!this._ptConnected || !this.pt.lastState) return; // ceased - hold, do not send

    const frame = this.deriveFrame(
      this.pt.lastState,
      Date.now(),
      this.pt.clockOffsetMs,
      { idleBehaviour: this.idleBehaviour },
    );
    const buf = encodeFrame(frame);

    this._sending = true;
    let result;
    try {
      this._inflight = this.sender.send(buf);
      result = await this._inflight;
    } finally {
      this._sending = false;
      this._inflight = null;
    }

    // stop()/dispose() may have run while we were awaiting - don't post a stale
    // timer frame after an intentional OFF.
    if (!this._outputActive) return;

    const now = Date.now();
    this._sendTimes = this._sendTimes.filter((t) => now - t < 1000);
    if (result && result.ok) this._sendTimes.push(now);

    this.status.noteSend(result && result.ok, { reason: result && result.error && String(result.error.message || result.error) });
    if (result && result.ok) {
      this.status.setOutput('running', { fps: this._sendTimes.length, lastFrame: describeFrame(buf) });
    }
    this.emit('frame', { buf, frame, decoded: describeFrame(buf), ok: !!(result && result.ok) });
  }

  async _sendOff(why) {
    try {
      const result = await this.sender.send(OFF_FRAME);
      this.emit('frame', { buf: OFF_FRAME, frame: { colour: 'off', reason: why }, decoded: describeFrame(OFF_FRAME), ok: !!(result && result.ok) });
    } catch { /* never throws upward */ }
  }

  _clearTick() {
    if (this._tick) { clearInterval(this._tick); this._tick = null; }
  }

  _log(level, message, meta) {
    if (this.log) this.log.push(level, message);
    this.emit('log', { level, message, meta });
  }
}

module.exports = { BridgeEngine, SERVER_INITIATED_RETRY_MS };

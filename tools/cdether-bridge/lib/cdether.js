'use strict';

// CDEther frame encoding + UDP transport.
//
// ============================================================================
// IMPORTANT: EMPIRICAL, NOT A SPECIFICATION
// ============================================================================
// Everything here is derived from our own test-rig observations driving a
// Hive/Interspace display through a CDEther receiver. It is NOT an official
// Hive/CDEther protocol document. Only the mappings below have been physically
// verified. Do not extend this with unverified colours, states, or field
// meanings.
//
// Verified frames (3 bytes, sent as UDP broadcast to port 36700):
//   99 95 01  -> 99:59 green
//   99 85 01  -> 99:58 green
//   99 75 01  -> 99:57 green
//   98 95 01  -> 89:59 green
//   21 43 01  -> 12:34 green
//   21 43 02  -> 12:34 red
//   21 43 03  -> 12:34 amber
//   21 43 04  -> display off
//
// Derived structure:
//   byte 1 = minutes as two BCD digits, nibble-swapped: low nibble = tens digit,
//            high nibble = ones digit.   (89 -> 0x98)
//   byte 2 = seconds, same nibble-swapped BCD.          (59 -> 0x95)
//   byte 3 = colour / state: 0x01 green, 0x02 red, 0x03 amber, 0x04 off.
// ============================================================================

const dgram = require('node:dgram');

const STATE_BYTE = { green: 0x01, red: 0x02, amber: 0x03, off: 0x04 };
const STATE_NAME = { 0x01: 'green', 0x02: 'red', 0x03: 'amber', 0x04: 'off' };

// Four BCD digits can only represent 00:00 .. 99:59.
const MAX_MINUTES = 99;
const MAX_SECONDS = 59;

/**
 * Encode one CDEther frame.
 * @param {{minutes?:number, seconds?:number, colour?:'green'|'red'|'amber'|'off'}} frame
 * @returns {Buffer} exactly 3 bytes
 */
function encodeFrame({ minutes = 0, seconds = 0, colour = 'green' } = {}) {
  const stateByte = STATE_BYTE[colour];
  if (stateByte === undefined) {
    throw new Error(`Unknown CDEther colour/state "${colour}" (verified: green|red|amber|off)`);
  }

  let mm = Math.floor(Number(minutes));
  let ss = Math.floor(Number(seconds));
  if (!Number.isFinite(mm) || mm < 0) mm = 0;
  if (!Number.isFinite(ss) || ss < 0) ss = 0;

  // Hard guard. Callers should already have clamped via state.js, but a frame
  // that can't be represented in BCD must never reach the wire.
  if (mm > MAX_MINUTES) { mm = MAX_MINUTES; ss = MAX_SECONDS; }
  if (ss > MAX_SECONDS) ss = MAX_SECONDS;

  const byte1 = ((mm % 10) << 4) | Math.floor(mm / 10);
  const byte2 = ((ss % 10) << 4) | Math.floor(ss / 10);

  return Buffer.from([byte1, byte2, stateByte]);
}

/** The OFF frame (`00 00 04`) - sent once on an intentional stop/exit. */
const OFF_FRAME = encodeFrame({ minutes: 0, seconds: 0, colour: 'off' });

/** Human-readable one-liner for logs: "[21 43 01] 12:34 green". */
function describeFrame(buf) {
  const hex = [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  const mm = (buf[0] & 0x0f) * 10 + (buf[0] >> 4);
  const ss = (buf[1] & 0x0f) * 10 + (buf[1] >> 4);
  const state = STATE_NAME[buf[2]] || `0x${buf[2].toString(16).padStart(2, '0')}`;
  return `[${hex}] ${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')} ${state}`;
}

/**
 * Minimal UDP broadcast sender. One socket, held open for the process lifetime.
 * Errors are surfaced via the `onError` callback; they are never thrown from
 * send() so the 1 Hz loop cannot be killed by a transient network fault.
 *
 * `bindAddress` (the chosen NIC's current IPv4) binds the socket to that
 * interface so directed broadcasts egress the CDEther adapter, not whichever
 * adapter the OS routing table happens to prefer on a multi-homed PC. Omit it
 * and the socket binds to all interfaces (the old POC behaviour).
 */
class UdpSender {
  constructor({ address, port, bindAddress = null }) {
    this.address = address;
    this.port = port;
    this.bindAddress = bindAddress;
    this.onError = null;
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    this.ready = new Promise((resolve, reject) => {
      const onBindError = (err) => reject(err);
      this.socket.once('error', onBindError);
      const afterBind = () => {
        try {
          this.socket.setBroadcast(true);
          this.socket.removeListener('error', onBindError);
          this.socket.on('error', (err) => {
            if (typeof this.onError === 'function') this.onError(err);
          });
          resolve();
        } catch (err) {
          reject(err);
        }
      };
      // bind(0, addr) picks an ephemeral source port on the chosen interface.
      if (this.bindAddress) this.socket.bind(0, this.bindAddress, afterBind);
      else this.socket.bind(afterBind);
    });
  }

  /**
   * Never rejects. Resolves `{ ok, error }` so the caller can drive status;
   * also calls `onError` on failure for logging. The 1 Hz loop must not be
   * killable by a transient network fault.
   */
  async send(buffer) {
    await this.ready;
    return new Promise((resolve) => {
      try {
        this.socket.send(buffer, this.port, this.address, (err) => {
          if (err && typeof this.onError === 'function') this.onError(err);
          resolve({ ok: !err, error: err || null });
        });
      } catch (err) {
        if (typeof this.onError === 'function') this.onError(err);
        resolve({ ok: false, error: err });
      }
    });
  }

  close() {
    if (this._closed) return Promise.resolve();
    this._closed = true;
    return new Promise((resolve) => {
      try {
        this.socket.close(resolve);
      } catch {
        resolve();
      }
    });
  }
}

module.exports = { encodeFrame, describeFrame, UdpSender, STATE_BYTE, OFF_FRAME };

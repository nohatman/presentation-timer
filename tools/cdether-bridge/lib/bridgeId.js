'use strict';

// A short, random, per-process correlation id sent with every bridgeStatus
// heartbeat (P2.1). Purely a label for logs/support - e.g. telling apart "the
// same bridge reconnecting" from "a second bridge" when the Control page
// reports multiple simultaneous sources for one room. NEVER used for
// identity or authorization (the server keys entries by its own
// server-assigned socket.id, never by this value).
//
// Not persisted yet - P2.1 is terminal-run only. A later configuration-
// storage slice will persist this alongside the rest of local config so it
// survives restarts; until then, a fresh id is generated per process run.

const crypto = require('node:crypto');

function generateBridgeId() {
  return crypto.randomBytes(8).toString('hex');
}

module.exports = { generateBridgeId };

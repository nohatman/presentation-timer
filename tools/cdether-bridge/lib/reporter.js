'use strict';

// Pure projection from a StatusModel snapshot (lib/status.js) to the small,
// fixed wire payload the bridge reports to the Presentation Timer server
// over its existing display-token Socket.IO connection (P2.1). Kept separate
// from lib/status.js and lib/engine.js so it's trivially unit-testable
// without a real socket, and so the proven local state machine stays
// untouched by wire-format concerns.
//
// The server (bridgeStatus.js, in the main app) independently validates and
// whitelists every field again on receipt - this module's job is only to
// build a well-formed payload, not to be the security boundary.

const SCHEMA_VERSION = 1;

// StatusModel's overall.state values map straight onto the public
// Off/Connecting/Live/Degraded/Error vocabulary; 'idle' (operator has not
// started, or pressed Stop) is the local name for what the Control page
// calls "Off".
const OVERALL_MAP = {
  idle: 'off',
  connecting: 'connecting',
  live: 'live',
  degraded: 'degraded',
  error: 'error',
};

/**
 * @param {object} statusSnapshot - result of StatusModel.snapshot()
 * @param {object} opts
 * @param {string|null} [opts.bridgeId] - persisted correlation id (lib/bridgeId.js)
 * @param {string|null} [opts.bridgeVersion] - from package.json
 * @param {string|null} [opts.interfaceName] - the selected NIC's name, if any
 */
function buildBridgeStatusPayload(statusSnapshot, { bridgeId = null, bridgeVersion = null, interfaceName = null } = {}) {
  const overall = OVERALL_MAP[statusSnapshot.overall.state] || 'error';
  return {
    v: SCHEMA_VERSION,
    bridgeId: bridgeId || null,
    bridgeVersion: bridgeVersion || null,
    overall,
    reason: statusSnapshot.overall.reason || null,
    output: statusSnapshot.output.state,
    ptConnected: statusSnapshot.pt.state === 'connected',
    interfaceName: interfaceName || null,
  };
}

module.exports = { buildBridgeStatusPayload, OVERALL_MAP };

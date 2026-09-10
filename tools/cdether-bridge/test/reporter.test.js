'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBridgeStatusPayload } = require('../lib/reporter');
const { StatusModel } = require('../lib/status');

function snap(setup) {
  const s = new StatusModel();
  setup(s);
  return s.snapshot();
}

test('idle (output stopped) maps to public "off"', () => {
  const p = buildBridgeStatusPayload(snap(() => {}));
  assert.equal(p.overall, 'off');
});

test('connecting (never yet live) maps to public "connecting"', () => {
  const p = buildBridgeStatusPayload(snap((s) => s.setOutput('running')));
  assert.equal(p.overall, 'connecting');
});

test('live maps to public "live"', () => {
  const p = buildBridgeStatusPayload(snap((s) => {
    s.setPt('connected', { room: 'X' });
    s.setOutput('running');
    s.noteSend(true);
  }));
  assert.equal(p.overall, 'live');
  assert.equal(p.ptConnected, true);
  assert.equal(p.output, 'running');
});

test('degraded (was live, PT lost) maps to public "degraded"', () => {
  const p = buildBridgeStatusPayload(snap((s) => {
    s.setPt('connected', { room: 'X' });
    s.setOutput('running');
    s.setPt('disconnected');
  }));
  assert.equal(p.overall, 'degraded');
  assert.match(p.reason, /holding its last value/i);
});

test('error (auth failure) maps to public "error"', () => {
  const p = buildBridgeStatusPayload(snap((s) => {
    s.setOutput('running');
    s.setPt('auth-failed');
  }));
  assert.equal(p.overall, 'error');
});

test('always includes the fixed schema version and whitelisted fields only', () => {
  const p = buildBridgeStatusPayload(snap(() => {}), { bridgeId: 'abc123', bridgeVersion: '1.2.3', interfaceName: 'Ethernet' });
  assert.equal(p.v, 1);
  assert.deepEqual(Object.keys(p).sort(), [
    'bridgeId', 'bridgeVersion', 'interfaceName', 'output', 'overall', 'ptConnected', 'reason', 'v',
  ].sort());
  assert.equal(p.bridgeId, 'abc123');
  assert.equal(p.bridgeVersion, '1.2.3');
  assert.equal(p.interfaceName, 'Ethernet');
});

test('never includes a room identifier of any kind', () => {
  const p = buildBridgeStatusPayload(snap((s) => s.setPt('connected', { room: 'BALLROOM' })));
  assert.equal(Object.prototype.hasOwnProperty.call(p, 'room'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(p, 'roomId'), false);
});

test('missing optional metadata defaults to null, not undefined or thrown', () => {
  const p = buildBridgeStatusPayload(snap(() => {}));
  assert.equal(p.bridgeId, null);
  assert.equal(p.bridgeVersion, null);
  assert.equal(p.interfaceName, null);
});

test('an unrecognised local overall state falls back to the safe "error" label rather than leaking an unknown value', () => {
  const s = new StatusModel();
  const badSnapshot = { ...s.snapshot(), overall: { state: 'totally-unknown', reason: 'huh' } };
  const p = buildBridgeStatusPayload(badSnapshot);
  assert.equal(p.overall, 'error');
});

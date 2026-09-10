'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBridgeStatusRegistry, validatePayload } = require('../bridgeStatus');

function validPayload(over = {}) {
  return {
    v: 1,
    bridgeId: 'a1b2c3d4e5f6a7b8',
    bridgeVersion: '0.2.0',
    overall: 'live',
    reason: 'Live - following room "keynote"',
    output: 'running',
    ptConnected: true,
    interfaceName: 'Ethernet',
    ...over,
  };
}

// ---- validatePayload ----

test('validatePayload accepts a well-formed payload and whitelists fields only', () => {
  const p = validatePayload(validPayload({ ts: 12345, extra: 'nope' }));
  assert.ok(p);
  assert.deepEqual(Object.keys(p).sort(), [
    'bridgeId', 'bridgeVersion', 'interfaceName', 'output', 'overall', 'ptConnected', 'reason', 'v',
  ].sort());
  assert.equal(p.ts, undefined);
  assert.equal(p.extra, undefined);
});

test('validatePayload rejects wrong schema version', () => {
  assert.equal(validatePayload(validPayload({ v: 2 })), null);
  assert.equal(validatePayload(validPayload({ v: undefined })), null);
});

test('validatePayload rejects unknown overall/output enum values', () => {
  assert.equal(validatePayload(validPayload({ overall: 'connected' })), null);
  assert.equal(validatePayload(validPayload({ output: 'idle' })), null);
});

test('validatePayload rejects non-boolean ptConnected', () => {
  assert.equal(validatePayload(validPayload({ ptConnected: 'true' })), null);
  assert.equal(validatePayload(validPayload({ ptConnected: undefined })), null);
});

test('validatePayload rejects malformed bridgeId, accepts missing/null', () => {
  assert.equal(validatePayload(validPayload({ bridgeId: 'not-hex!!' })), null);
  assert.equal(validatePayload(validPayload({ bridgeId: 'x'.repeat(40) })), null);
  assert.ok(validatePayload(validPayload({ bridgeId: undefined })));
  assert.ok(validatePayload(validPayload({ bridgeId: null })));
});

test('validatePayload enforces length caps on free-text fields', () => {
  assert.equal(validatePayload(validPayload({ reason: 'x'.repeat(161) })), null);
  assert.ok(validatePayload(validPayload({ reason: 'x'.repeat(160) })));
  assert.equal(validatePayload(validPayload({ bridgeVersion: 'x'.repeat(33) })), null);
  assert.equal(validatePayload(validPayload({ interfaceName: 'x'.repeat(65) })), null);
});

test('validatePayload rejects non-string free-text fields', () => {
  assert.equal(validatePayload(validPayload({ reason: 12345 })), null);
  assert.equal(validatePayload(validPayload({ interfaceName: { name: 'Ethernet' } })), null);
});

test('validatePayload strips control characters from text fields', () => {
  const p = validatePayload(validPayload({ reason: 'line1\u0000line2\u0007' }));
  assert.equal(p.reason, 'line1line2');
});

test('validatePayload rejects non-object / null input without throwing', () => {
  assert.equal(validatePayload(null), null);
  assert.equal(validatePayload(undefined), null);
  assert.equal(validatePayload('a string'), null);
  assert.equal(validatePayload(42), null);
});

test('validatePayload drops a client-declared roomId rather than passing it through (spoof attempt)', () => {
  const p = validatePayload(validPayload({ roomId: 'some-other-room' }));
  assert.ok(p);
  assert.equal(p.roomId, undefined);
});

// ---- registry: room isolation / effectiveStatus ----

test('a room with no report ever is null (no pill shown)', () => {
  const reg = createBridgeStatusRegistry();
  assert.equal(reg.effectiveStatus('roomA'), null);
});

test('recording for one room never affects another room (tenancy isolation)', () => {
  const reg = createBridgeStatusRegistry();
  reg.record('roomA', 'sockA', validPayload({ overall: 'live' }));
  assert.equal(reg.effectiveStatus('roomB'), null);
  assert.equal(reg.effectiveStatus('roomA').overall, 'live');
});

test('a single bridge report maps directly to the effective status', () => {
  const reg = createBridgeStatusRegistry();
  reg.record('roomA', 'sockA', validPayload({ overall: 'degraded', reason: 'connecting' }));
  const s = reg.effectiveStatus('roomA');
  assert.equal(s.overall, 'degraded');
  assert.equal(s.reason, 'connecting');
  assert.equal(s.sources, 1);
});

test('an invalid payload is not accepted and does not create a room entry', () => {
  const reg = createBridgeStatusRegistry();
  const result = reg.record('roomA', 'sockA', { overall: 'bogus' });
  assert.equal(result.accepted, false);
  assert.equal(reg.effectiveStatus('roomA'), null);
});

// ---- multiple bridges ----

test('two simultaneous bridges for one room are surfaced as an honest degraded warning, not silently merged', () => {
  const reg = createBridgeStatusRegistry();
  reg.record('roomA', 'sockA', validPayload({ overall: 'live' }));
  reg.record('roomA', 'sockB', validPayload({ overall: 'live' }));
  const s = reg.effectiveStatus('roomA');
  assert.equal(s.overall, 'degraded');
  assert.equal(s.sources, 2);
  assert.match(s.reason, /2 Physical Display Output sources/);
});

test('clearing one of two bridges reverts to the remaining bridge\'s own status', () => {
  const reg = createBridgeStatusRegistry();
  reg.record('roomA', 'sockA', validPayload({ overall: 'live' }));
  reg.record('roomA', 'sockB', validPayload({ overall: 'error', reason: 'boom' }));
  reg.clear('roomA', 'sockA');
  const s = reg.effectiveStatus('roomA');
  assert.equal(s.sources, 1);
  assert.equal(s.overall, 'error');
});

// ---- disconnect cleanup ----

test('clear() removes only the named socket\'s entry, immediately', () => {
  const reg = createBridgeStatusRegistry();
  reg.record('roomA', 'sockA', validPayload());
  const had = reg.clear('roomA', 'sockA');
  assert.equal(had, true);
  const s = reg.effectiveStatus('roomA');
  assert.equal(s.overall, 'off');
  assert.equal(s.sources, 0);
});

test('clear() on an unknown socket/room is a safe no-op', () => {
  const reg = createBridgeStatusRegistry();
  assert.equal(reg.clear('roomA', 'sockA'), false);
  reg.record('roomA', 'sockA', validPayload());
  assert.equal(reg.clear('roomA', 'sockDoesNotExist'), false);
});

// ---- staleness ----

test('sweepStale removes entries older than STALE_MS and reports the changed room', () => {
  const reg = createBridgeStatusRegistry();
  reg.record('roomA', 'sockA', validPayload());
  const changed = reg.sweepStale(Date.now() + 999999);
  assert.deepEqual(changed, ['roomA']);
  assert.equal(reg.effectiveStatus('roomA').overall, 'off');
});

test('sweepStale leaves fresh entries alone', () => {
  const reg = createBridgeStatusRegistry();
  reg.record('roomA', 'sockA', validPayload());
  const changed = reg.sweepStale(Date.now());
  assert.deepEqual(changed, []);
  assert.equal(reg.effectiveStatus('roomA').overall, 'live');
});

// ---- rate limiting ----

test('rate limiting drops excess events but keeps the most recent accepted state', () => {
  const reg = createBridgeStatusRegistry();
  let accepted = 0;
  for (let i = 0; i < 10; i++) {
    const r = reg.record('roomA', 'sockA', validPayload());
    if (r.accepted) accepted += 1;
  }
  assert.ok(accepted <= 2, `expected the per-second cap to hold, got ${accepted} accepted`);
  assert.equal(reg.effectiveStatus('roomA').overall, 'live');
});

test('rate limiting is per-socket, not global', () => {
  const reg = createBridgeStatusRegistry();
  for (let i = 0; i < 10; i++) reg.record('roomA', 'sockA', validPayload());
  const resultForOtherSocket = reg.record('roomA', 'sockB', validPayload());
  assert.equal(resultForOtherSocket.accepted, true);
});

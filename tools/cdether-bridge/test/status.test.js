'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { StatusModel } = require('../lib/status');

test('initial state is idle / disconnected / stopped', () => {
  const s = new StatusModel();
  const snap = s.snapshot();
  assert.equal(snap.pt.state, 'disconnected');
  assert.equal(snap.output.state, 'stopped');
  assert.equal(snap.overall.state, 'idle');
});

test('connected + running + send ok -> live, names the room', () => {
  const s = new StatusModel();
  s.setPt('connected', { room: 'BALLROOM' });
  s.setOutput('running');
  s.noteSend(true);
  const snap = s.snapshot();
  assert.equal(snap.overall.state, 'live');
  assert.match(snap.overall.reason, /BALLROOM/);
});

test('connected but output stopped -> idle', () => {
  const s = new StatusModel();
  s.setPt('connected', { room: 'X' });
  assert.equal(s.snapshot().overall.state, 'idle');
});

test('running, then PT lost -> degraded with "holding its last value" wording', () => {
  const s = new StatusModel();
  s.setPt('connected', { room: 'X' });
  s.setOutput('running');
  s.noteSend(true);
  s.setPt('disconnected');
  const snap = s.snapshot();
  assert.equal(snap.overall.state, 'degraded');
  assert.match(snap.overall.reason, /holding its last value/i);
});

test('running, never yet connected -> connecting, not degraded (P2.1)', () => {
  const s = new StatusModel();
  s.setOutput('running');
  assert.equal(s.snapshot().overall.state, 'connecting');
});

test('running, PT reconnecting -> degraded', () => {
  const s = new StatusModel();
  s.setPt('connected', { room: 'X' });
  s.setOutput('running');
  s.setPt('connecting');
  assert.equal(s.snapshot().overall.state, 'degraded');
});

test('server-unreachable while running, never yet connected -> connecting (P2.1)', () => {
  const s = new StatusModel();
  s.setOutput('running');
  s.setPt('server-unreachable');
  assert.equal(s.snapshot().overall.state, 'connecting');
});

test('server-unreachable after having been live -> degraded', () => {
  const s = new StatusModel();
  s.setPt('connected', { room: 'X' });
  s.setOutput('running');
  s.setPt('server-unreachable');
  assert.equal(s.snapshot().overall.state, 'degraded');
});

test('auth-failed -> error regardless of output', () => {
  const s = new StatusModel();
  s.setOutput('running');
  s.setPt('auth-failed');
  assert.equal(s.snapshot().overall.state, 'error');
  assert.match(s.snapshot().overall.reason, /token/i);
});

test('room-unavailable -> error', () => {
  const s = new StatusModel();
  s.setOutput('running');
  s.setPt('room-unavailable');
  assert.equal(s.snapshot().overall.state, 'error');
});

test('UDP send failure -> send-error -> overall error; recovers on next ok', () => {
  const s = new StatusModel();
  s.setPt('connected', { room: 'X' });
  s.setOutput('running');
  s.noteSend(false, { reason: 'ENETUNREACH' });
  assert.equal(s.snapshot().output.state, 'send-error');
  assert.equal(s.snapshot().overall.state, 'error');
  assert.match(s.snapshot().overall.reason, /ENETUNREACH/);
  s.noteSend(true);
  assert.equal(s.snapshot().output.state, 'running');
  assert.equal(s.snapshot().overall.state, 'live');
});

test('emits change only on an actual transition', () => {
  const s = new StatusModel();
  let changes = 0;
  s.on('change', () => { changes++; });
  s.setPt('connecting');            // change
  s.setPt('connecting');            // no change
  s.setOutput('running');           // change (overall idle->connecting: running, never yet live)
  s.noteSend(true);                 // no overall change
  assert.equal(changes, 2);
});

test('since timestamps advance only when the state changes', async () => {
  const s = new StatusModel();
  s.setPt('connecting');
  const t1 = s.snapshot().pt.since;
  await new Promise((r) => setTimeout(r, 5));
  s.setPt('connecting');
  assert.equal(s.snapshot().pt.since, t1, 'no-op setPt must not move since');
  await new Promise((r) => setTimeout(r, 5));
  s.setPt('connected', { room: 'X' });
  assert.ok(s.snapshot().pt.since > t1);
});

test('snapshot is frozen', () => {
  const s = new StatusModel();
  const snap = s.snapshot();
  assert.throws(() => { snap.overall.state = 'live'; }, TypeError);
});

test('rejects unknown states', () => {
  const s = new StatusModel();
  assert.throws(() => s.setPt('weird'));
  assert.throws(() => s.setOutput('weird'));
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getDemoConfig, seedDemoState, createHourlyLimiter, SAMPLE_RUNDOWN } = require('../demoRooms');
const timerModes = require('../timerModes');

test('config defaults, overrides, and bad values fall back', () => {
  assert.deepEqual(getDemoConfig({}), { ttlMs: 120 * 60 * 1000, maxActive: 100, perIpPerHour: 3, sweepMs: 60 * 1000 });
  const c = getDemoConfig({ DEMO_TTL_MIN: '30', DEMO_MAX_ACTIVE: '5', DEMO_PER_IP_PER_HOUR: '1', DEMO_SWEEP_MS: '500' });
  assert.deepEqual(c, { ttlMs: 30 * 60 * 1000, maxActive: 5, perIpPerHour: 1, sweepMs: 500 });
  assert.equal(getDemoConfig({ DEMO_TTL_MIN: '0.05' }).ttlMs, 3000);
  assert.deepEqual(getDemoConfig({ DEMO_TTL_MIN: 'x', DEMO_MAX_ACTIVE: '-2', DEMO_PER_IP_PER_HOUR: '1.5' }), getDemoConfig({}));
});

test('seeded state: sample rundown with the first item loaded, stopped', () => {
  const s = seedDemoState({ mode: 'running', rundown: [], rundownIndex: -1, amberThresholdMs: 1, redThresholdMs: 1 }, timerModes.loadRundownItem);
  assert.equal(s.rundown.length, SAMPLE_RUNDOWN.length);
  assert.notEqual(s.rundown[0], SAMPLE_RUNDOWN[0], 'rundown items are copies');
  assert.equal(s.rundownIndex, 0);
  assert.equal(s.mode, 'stopped');
  assert.equal(s.durationMs, SAMPLE_RUNDOWN[0].durationMs);
  assert.equal(s.amberThresholdMs, 60 * 1000);
  assert.equal(s.redThresholdMs, 30 * 1000);
});

test('hourly limiter: per key, sliding window', () => {
  const l = createHourlyLimiter(2, 1000);
  assert.equal(l.take('a', 0), true);
  assert.equal(l.take('a', 10), true);
  assert.equal(l.take('a', 20), false);
  assert.equal(l.take('b', 20), true, 'other keys unaffected');
  assert.equal(l.take('a', 1001), true, 'first hit has aged out');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveFrame } = require('../lib/state');

const NOW = 1_700_000_000_000;

// Mirrors server.js createDefaultTimerState().
function state(over = {}) {
  return {
    mode: 'stopped',
    durationMs: 30 * 60 * 1000,
    startTime: null,
    pauseTime: null,
    accumulatedPauseMs: 0,
    speed: 1.0,
    amberThresholdMs: 5 * 60 * 1000,
    redThresholdMs: 2 * 60 * 1000,
    countUp: false,
    showClock: false,
    outputMode: 'timer',
    message: '',
    messageMode: 'none',
    ...over,
  };
}
const mss = (f) => [f.minutes, f.seconds, f.colour];

test('stopped + idle=duration -> armed duration in green', () => {
  const f = deriveFrame(state({ durationMs: 20 * 60 * 1000 }), NOW, 0, { idleBehaviour: 'duration' });
  assert.deepEqual(mss(f), [20, 0, 'green']);
});

test('stopped + idle=off -> off', () => {
  assert.equal(deriveFrame(state(), NOW, 0, { idleBehaviour: 'off' }).colour, 'off');
});

test('running, plenty of time -> green with correct MM:SS', () => {
  const f = deriveFrame(state({ mode: 'running', durationMs: 600000, startTime: NOW - 60000 }), NOW, 0, {});
  assert.deepEqual(mss(f), [9, 0, 'green']);
});

test('running, at amber threshold -> amber', () => {
  const s = state({ mode: 'running', durationMs: 600000, startTime: NOW - (600000 - 5 * 60 * 1000) });
  assert.equal(deriveFrame(s, NOW, 0, {}).colour, 'amber');
});

test('running, at red threshold -> red', () => {
  const s = state({ mode: 'running', durationMs: 600000, startTime: NOW - (600000 - 2 * 60 * 1000) });
  assert.equal(deriveFrame(s, NOW, 0, {}).colour, 'red');
});

test('finished countdown -> 00:00 red', () => {
  const s = state({ mode: 'running', durationMs: 60000, startTime: NOW - 90000 });
  assert.deepEqual(mss(deriveFrame(s, NOW, 0, {})), [0, 0, 'red']);
});

test('unverified overtime (countUp) still -> 00:00 red in POC', () => {
  const s = state({ mode: 'running', countUp: true, durationMs: 60000, startTime: NOW - 120000 });
  assert.deepEqual(mss(deriveFrame(s, NOW, 0, {})), [0, 0, 'red']);
});

test('paused freezes the value regardless of wall-clock', () => {
  const s = state({ mode: 'paused', durationMs: 600000, startTime: NOW - 300000, pauseTime: NOW - 120000 });
  const a = deriveFrame(s, NOW, 0, {});
  const b = deriveFrame(s, NOW + 10 * 60 * 1000, 0, {});
  assert.deepEqual(mss(a), mss(b));
  // elapsed at pause = 300000 - 120000 = 180000 -> remaining 420000 -> 07:00 (green)
  assert.deepEqual(mss(a), [7, 0, 'green']);
});

test('accumulatedPauseMs is honoured', () => {
  const s = state({ mode: 'running', durationMs: 600000, startTime: NOW - 300000, accumulatedPauseMs: 60000 });
  // effective elapsed = 300000 - 60000 = 240000 -> remaining 360000 -> 06:00
  // (6:00 remaining is still above the 5:00 amber threshold -> green)
  assert.deepEqual(mss(deriveFrame(s, NOW, 0, {})), [6, 0, 'green']);
});

test('clock mode -> off (both flags)', () => {
  assert.equal(deriveFrame(state({ showClock: true }), NOW, 0, {}).colour, 'off');
  assert.equal(deriveFrame(state({ outputMode: 'clock' }), NOW, 0, {}).colour, 'off');
});

test('overlay message -> off; ticker message -> timer still shown', () => {
  assert.equal(deriveFrame(state({ messageMode: 'overlay', message: 'STAND BY' }), NOW, 0, {}).colour, 'off');
  const t = deriveFrame(
    state({ mode: 'running', durationMs: 600000, startTime: NOW - 60000, messageMode: 'ticker', message: 'hi' }),
    NOW, 0, {},
  );
  assert.deepEqual(mss(t), [9, 0, 'green']);
});

test('server clock offset is applied to remaining time', () => {
  // startTime is in the server epoch; local clock runs 30s behind the server.
  const s = state({ mode: 'running', durationMs: 600000, startTime: NOW - 60000 });
  const f = deriveFrame(s, NOW - 30000, 30000, {});
  assert.deepEqual(mss(f), [9, 0, 'green']);
});

test('remaining above 99:59 clamps to 99:59', () => {
  const s = state({ mode: 'running', durationMs: 150 * 60 * 1000, startTime: NOW - 1000 });
  assert.deepEqual([deriveFrame(s, NOW, 0, {}).minutes, deriveFrame(s, NOW, 0, {}).seconds], [99, 59]);
});

test('speed multiplier is honoured', () => {
  const s = state({ mode: 'running', durationMs: 600000, startTime: NOW - 60000, speed: 2.0 });
  // elapsed = 60000 * 2 = 120000 -> remaining 480000 -> 08:00
  assert.deepEqual(mss(deriveFrame(s, NOW, 0, {})), [8, 0, 'green']);
});

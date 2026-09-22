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

// Constructs a timestamp that reads as h:m:s in THIS machine's local
// timezone, so clock-mode tests are timezone-independent - deriveFrame uses
// local Date methods (new Date(nowCorrected).getHours()/.getMinutes()),
// same basis as display.html's own clock rendering.
const localTime = (h, m, sec = 0) => new Date(2026, 0, 1, h, m, sec, 0).getTime();

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

// ---- P1.1: time-of-day / clock mode -> HH:MM green (reuses the proven BCD encoding) ----

test('clock mode: 00:00 -> HH:MM green (both flags)', () => {
  assert.deepEqual(mss(deriveFrame(state({ showClock: true }), localTime(0, 0), 0, {})), [0, 0, 'green']);
  assert.deepEqual(mss(deriveFrame(state({ outputMode: 'clock' }), localTime(0, 0), 0, {})), [0, 0, 'green']);
});

test('clock mode: 09:05 -> HH:MM green (native leading-zero suppression is accepted display behaviour, not our concern)', () => {
  assert.deepEqual(mss(deriveFrame(state({ showClock: true }), localTime(9, 5), 0, {})), [9, 5, 'green']);
});

test('clock mode: 12:00 -> HH:MM green', () => {
  assert.deepEqual(mss(deriveFrame(state({ showClock: true }), localTime(12, 0), 0, {})), [12, 0, 'green']);
});

test('clock mode: 23:59 -> HH:MM green', () => {
  assert.deepEqual(mss(deriveFrame(state({ showClock: true }), localTime(23, 59), 0, {})), [23, 59, 'green']);
});

test('clock mode: server clock offset is applied (bridge-local clock differs from server)', () => {
  // Bridge-local wall clock reads 23:58; the server is 4 minutes ahead, so
  // the server-corrected time is 00:02 (the next day).
  const bridgeLocalNow = localTime(23, 58);
  const clockOffsetMs = 4 * 60 * 1000;
  assert.deepEqual(mss(deriveFrame(state({ showClock: true }), bridgeLocalNow, clockOffsetMs, {})), [0, 2, 'green']);
});

test('clock mode always outputs green, regardless of the room\'s countdown thresholds', () => {
  const s = state({ showClock: true, amberThresholdMs: 999999999, redThresholdMs: 999999999 });
  assert.equal(deriveFrame(s, localTime(9, 5), 0, {}).colour, 'green');
});

test('overlay message still overrides clock mode -> off', () => {
  const s = state({ showClock: true, messageMode: 'overlay', message: 'STAND BY' });
  assert.equal(deriveFrame(s, localTime(9, 5), 0, {}).colour, 'off');
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

test('remaining at exactly 99:59 stays plain MM:SS, not hours mode', () => {
  const s = state({ mode: 'running', durationMs: 99 * 60 * 1000 + 59000, startTime: NOW });
  const f = deriveFrame(s, NOW, 0, {});
  assert.deepEqual([f.minutes, f.seconds, f.hoursMode], [99, 59, false]);
});

test('remaining above 99:59 switches to H:MM instead of clamping/holding at 99:59', () => {
  // 149:59 remaining (~1s already elapsed of a 150-minute duration) -> 2h29m.
  const s = state({ mode: 'running', durationMs: 150 * 60 * 1000, startTime: NOW - 1000 });
  const f = deriveFrame(s, NOW, 0, {});
  assert.deepEqual([f.minutes, f.seconds, f.hoursMode], [2, 29, true]);
});

test('hours mode reverts to plain MM:SS once remaining drops back under 100 minutes', () => {
  const s = state({ mode: 'running', durationMs: 100 * 60 * 1000, startTime: NOW - 60 * 1000 });
  const f = deriveFrame(s, NOW, 0, {}); // 99:00 remaining
  assert.deepEqual([f.minutes, f.seconds, f.hoursMode], [99, 0, false]);
});

test('speed multiplier is honoured', () => {
  const s = state({ mode: 'running', durationMs: 600000, startTime: NOW - 60000, speed: 2.0 });
  // elapsed = 60000 * 2 = 120000 -> remaining 480000 -> 08:00
  assert.deepEqual(mss(deriveFrame(s, NOW, 0, {})), [8, 0, 'green']);
});

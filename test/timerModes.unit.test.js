'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tm = require('../timerModes');

const MIN = 60000;
// Fixed instant: 2026-06-15 13:00:00 UTC. BST operator => UTC offset -60 => 14:00 local.
const NOW = Date.UTC(2026, 5, 15, 13, 0, 0);
const BST = -60;

function fresh(over = {}) {
  return tm.normalizeState({
    mode: 'stopped', durationMs: 30 * MIN, startTime: null, pauseTime: null, accumulatedPauseMs: 0,
    endAtTarget: null, rundown: [], rundownIndex: -1, ...over,
  });
}

test('endAtDurationMs: HH:MM is the OPERATOR wall clock, whatever timezone the server runs in', () => {
  assert.equal(tm.endAtDurationMs('14:30', BST, NOW), 30 * MIN);
  // Same instant, operator in UTC: 14:30 is 90 min away
  assert.equal(tm.endAtDurationMs('14:30', 0, NOW), 90 * MIN);
  // Operator at UTC-5 (13:00Z = 08:00 local)
  assert.equal(tm.endAtDurationMs('09:00', 300, NOW), 60 * MIN);
});

test('endAtDurationMs: a target at or before now rolls to tomorrow; invalid => null', () => {
  assert.equal(tm.endAtDurationMs('14:00', BST, NOW), 24 * 60 * MIN); // exactly now => tomorrow
  assert.equal(tm.endAtDurationMs('13:59', BST, NOW), (24 * 60 - 1) * MIN);
  for (const bad of ['', null, undefined, 'abc', '24:00', '12:60', '1230', '12:5']) {
    assert.equal(tm.endAtDurationMs(bad, BST, NOW), null, String(bad));
  }
  assert.equal(tm.parseEndAt('9:05').text, '09:05');
});

test('Duration: Start uses the configured duration; Reset returns to it', () => {
  const s = fresh();
  tm.applyTimerConfig(s, { durationMs: 10 * MIN }, NOW);
  assert.equal(s.timerMode, 'duration');
  assert.equal(s.durationMs, 10 * MIN);
  tm.startTimer(s, {}, NOW);
  assert.equal(s.mode, 'running');
  assert.equal(s.durationMs, 10 * MIN);
  tm.nudge(s, 2 * MIN, NOW + 1000); // live nudge: this run only
  assert.equal(s.durationMs, 12 * MIN);
  tm.resetTimer(s, NOW + 2000);
  assert.equal(s.mode, 'stopped');
  assert.equal(s.durationMs, 10 * MIN, 'Reset restores the configured duration, not the nudged run length');
});

test('Duration: editing while paused changes configuration only, never the live run', () => {
  const s = fresh();
  tm.applyTimerConfig(s, { durationMs: 10 * MIN }, NOW);
  tm.startTimer(s, {}, NOW);
  s.mode = 'paused'; s.pauseTime = NOW + 1000;
  tm.applyTimerConfig(s, { timerMode: 'duration', endAtTarget: '15:00', endAtTzOffsetMin: BST }, NOW + 2000);
  assert.equal(s.mode, 'paused');
  assert.equal(s.startTime, NOW);
  // (a legacy live duration edit is still honoured - documented legacy behaviour)
  assert.equal(s.durationMs, 10 * MIN);
});

test('End at: Start derives the run from the clock; Reset re-derives from the kept target', () => {
  const s = fresh();
  tm.applyTimerConfig(s, { endAtTarget: '14:30', endAtTzOffsetMin: BST }, NOW);
  assert.equal(s.timerMode, 'endAt');
  assert.equal(s.durationMs, 30 * MIN);
  const later = NOW + 5 * MIN;
  tm.startTimer(s, {}, later);
  assert.equal(s.durationMs, 25 * MIN, 'Start re-derives from the clock at Start time');
  const muchLater = NOW + 10 * MIN;
  tm.resetTimer(s, muchLater);
  assert.equal(s.mode, 'stopped');
  assert.equal(s.endAtTarget, '14:30', 'Reset keeps the target');
  assert.equal(s.timerMode, 'endAt', 'Reset does not fall back to Duration');
  assert.equal(s.durationMs, 20 * MIN, 'Reset shows time-to-target now, not the stale value from the previous Start');
});

test('End at: editing the target while stopped re-derives; while running only the config changes', () => {
  const s = fresh();
  tm.applyTimerConfig(s, { endAtTarget: '14:30', endAtTzOffsetMin: BST }, NOW);
  tm.applyTimerConfig(s, { endAtTarget: '14:10', endAtTzOffsetMin: BST }, NOW);
  assert.equal(s.durationMs, 10 * MIN);
  tm.startTimer(s, {}, NOW);
  tm.applyTimerConfig(s, { endAtTarget: '16:00', endAtTzOffsetMin: BST }, NOW + MIN);
  assert.equal(s.durationMs, 10 * MIN, 'live run untouched');
  assert.equal(s.endAtTarget, '16:00', 'configuration updated for next Reset/Start');
  tm.resetTimer(s, NOW + 2 * MIN);
  assert.equal(s.durationMs, 118 * MIN);
});

test('mode switching while stopped: each mode keeps its own value, no stale carry-over', () => {
  const s = fresh();
  tm.applyTimerConfig(s, { durationMs: 12 * MIN }, NOW);
  tm.applyTimerConfig(s, { endAtTarget: '14:30', endAtTzOffsetMin: BST }, NOW);
  assert.equal(s.timerMode, 'endAt');
  assert.equal(s.durationMs, 30 * MIN);
  assert.equal(s.configDurationMs, 12 * MIN, 'Duration setting preserved while End at is active');
  tm.applyTimerConfig(s, { timerMode: 'duration' }, NOW);
  assert.equal(s.durationMs, 12 * MIN, 'switching back restores the Duration setting, not the End-at-derived one');
  assert.equal(s.endAtTarget, '14:30', 'End-at setting preserved while Duration is active');
  tm.applyTimerConfig(s, { timerMode: 'endAt' }, NOW + MIN);
  assert.equal(s.durationMs, 29 * MIN);
});

test('typing a duration while End at is active switches to Duration (last edit wins)', () => {
  const s = fresh();
  tm.applyTimerConfig(s, { endAtTarget: '14:30', endAtTzOffsetMin: BST }, NOW);
  tm.applyTimerConfig(s, { durationMs: 7 * MIN }, NOW);
  assert.equal(s.timerMode, 'duration');
  assert.equal(s.durationMs, 7 * MIN);
  tm.startTimer(s, {}, NOW);
  assert.equal(s.durationMs, 7 * MIN);
});

test('End at requested without a valid target is refused (stays Duration)', () => {
  const s = fresh();
  tm.applyTimerConfig(s, { timerMode: 'endAt' }, NOW);
  assert.equal(s.timerMode, 'duration');
  tm.applyTimerConfig(s, { timerMode: 'endAt', endAtTarget: 'nope' }, NOW);
  assert.equal(s.timerMode, 'duration');
  assert.equal(s.endAtTarget, null);
});

test('mode switch while running/paused changes config only; Reset then applies it', () => {
  const s = fresh();
  tm.applyTimerConfig(s, { durationMs: 10 * MIN, endAtTarget: '14:30', endAtTzOffsetMin: BST }, NOW); // Duration active
  tm.startTimer(s, {}, NOW);
  tm.applyTimerConfig(s, { timerMode: 'endAt' }, NOW + MIN);
  assert.equal(s.timerMode, 'endAt');
  assert.equal(s.mode, 'running');
  assert.equal(s.durationMs, 10 * MIN, 'running length untouched');
  tm.resetTimer(s, NOW + 2 * MIN);
  assert.equal(s.durationMs, 28 * MIN, 'Reset now reflects End at');
  tm.applyTimerConfig(s, { timerMode: 'duration' }, NOW + 2 * MIN);
  assert.equal(s.durationMs, 10 * MIN);
});

test('nudge while stopped in End at becomes a fixed Duration (not silently discarded at Start)', () => {
  const s = fresh();
  tm.applyTimerConfig(s, { endAtTarget: '14:30', endAtTzOffsetMin: BST }, NOW);
  tm.nudge(s, MIN, NOW);
  assert.equal(s.timerMode, 'duration');
  assert.equal(s.durationMs, 31 * MIN);
  tm.startTimer(s, {}, NOW + 10 * MIN);
  assert.equal(s.durationMs, 31 * MIN);
});

test('rundown item: its duration becomes the Duration config, Duration mode, End-at target cleared', () => {
  const s = fresh({ rundown: [{ name: 'A', durationMs: 5 * MIN }, { name: 'B', durationMs: 10 * MIN }] });
  tm.applyTimerConfig(s, { endAtTarget: '14:30', endAtTzOffsetMin: BST }, NOW);
  tm.loadRundownItem(s, 1, false, NOW);
  assert.equal(s.timerMode, 'duration');
  assert.equal(s.endAtTarget, null);
  assert.equal(s.durationMs, 10 * MIN);
  tm.startTimer(s, {}, NOW);
  assert.equal(s.durationMs, 10 * MIN);
  tm.resetTimer(s, NOW);
  assert.equal(s.durationMs, 10 * MIN, 'Reset returns to the item duration');
  tm.loadRundownItem(s, 0, true, NOW);
  assert.equal(s.mode, 'running');
  assert.equal(s.startTime, NOW);
});

test('legacy client payloads: durationMs alone => Duration; endAtTarget alone => End at; both => Duration', () => {
  let s = fresh();
  tm.applyTimerConfig(s, { endAtTarget: '14:30', endAtTzOffsetMin: BST }, NOW);
  assert.equal(s.timerMode, 'endAt');
  tm.applyTimerConfig(s, { durationMs: 9 * MIN }, NOW);
  assert.equal(s.timerMode, 'duration');
  s = fresh();
  tm.applyTimerConfig(s, { durationMs: 9 * MIN, endAtTarget: '14:30' }, NOW);
  assert.equal(s.timerMode, 'duration');
  assert.equal(s.durationMs, 9 * MIN);
});

test('normalizeState adopts a legacy persisted duration as the configured one', () => {
  const s = tm.normalizeState({ mode: 'stopped', durationMs: 15 * MIN, endAtTarget: 'garbage' });
  assert.equal(s.configDurationMs, 15 * MIN);
  assert.equal(s.timerMode, 'duration');
  assert.equal(s.endAtTarget, null);
});

test('setDuration (REST set-duration) selects Duration and keeps live-edit legacy behaviour', () => {
  const s = fresh();
  tm.applyTimerConfig(s, { endAtTarget: '14:30', endAtTzOffsetMin: BST }, NOW);
  tm.setDuration(s, 6 * MIN, NOW);
  assert.equal(s.timerMode, 'duration');
  assert.equal(s.durationMs, 6 * MIN);
  assert.equal(s.configDurationMs, 6 * MIN);
});

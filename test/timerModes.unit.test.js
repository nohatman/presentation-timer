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
    mode: 'stopped', speed: 1, durationMs: 30 * MIN, startTime: null, pauseTime: null, accumulatedPauseMs: 0,
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

test('End-at pause/resume: the finish stays the absolute wall-clock target (pause only freezes the display)', () => {
  const s = fresh();
  tm.applyTimerConfig(s, { endAtTarget: '14:30', endAtTzOffsetMin: BST }, NOW); // 30 min away
  tm.startTimer(s, {}, NOW);
  const target = NOW + 30 * MIN;
  assert.equal(s.runEndAtMs, target);
  s.mode = 'paused'; s.pauseTime = NOW + 5 * MIN; // paused with 25 min left
  tm.resumeTimer(s, NOW + 15 * MIN); // 10 min pause
  assert.equal(s.mode, 'running');
  assert.equal(s.pauseTime, null);
  const finish = s.startTime + s.accumulatedPauseMs + s.durationMs / s.speed;
  assert.equal(finish, target, 'finish unchanged by the pause');
  const remaining = s.durationMs - (NOW + 15 * MIN - s.startTime - s.accumulatedPauseMs) * s.speed;
  assert.equal(remaining, 15 * MIN, 'remaining = target - now, not the frozen 25 min');
});

test('Duration pause/resume: unchanged - the pause shifts the finish later', () => {
  const s = fresh();
  tm.applyTimerConfig(s, { durationMs: 30 * MIN }, NOW);
  tm.startTimer(s, {}, NOW);
  assert.equal(s.runEndAtMs, null);
  s.mode = 'paused'; s.pauseTime = NOW + 5 * MIN;
  tm.resumeTimer(s, NOW + 15 * MIN);
  assert.equal(s.accumulatedPauseMs, 10 * MIN);
  const remaining = s.durationMs - (NOW + 15 * MIN - s.startTime - s.accumulatedPauseMs) * s.speed;
  assert.equal(remaining, 25 * MIN, 'still the frozen 25 min');
});

test('End-at: resuming after the target has passed goes into overrun (no next-day roll)', () => {
  const s = fresh();
  tm.applyTimerConfig(s, { endAtTarget: '14:30', endAtTzOffsetMin: BST }, NOW);
  tm.startTimer(s, {}, NOW);
  s.mode = 'paused'; s.pauseTime = NOW + 5 * MIN;
  tm.resumeTimer(s, NOW + 40 * MIN);
  const remaining = s.durationMs - (NOW + 40 * MIN - s.startTime - s.accumulatedPauseMs) * s.speed;
  assert.equal(remaining, -10 * MIN);
});

test('End-at: the run mode is fixed at Start - switching mode while paused does not change how it resumes', () => {
  const s = fresh();
  tm.applyTimerConfig(s, { endAtTarget: '14:30', endAtTzOffsetMin: BST }, NOW);
  tm.startTimer(s, {}, NOW);
  s.mode = 'paused'; s.pauseTime = NOW + 5 * MIN;
  tm.applyTimerConfig(s, { timerMode: 'duration' }, NOW + 6 * MIN);
  tm.resumeTimer(s, NOW + 15 * MIN);
  assert.equal(s.startTime + s.accumulatedPauseMs + s.durationMs, NOW + 30 * MIN);
  // and the reverse: a Duration run stays a shift-on-pause run even if End at is configured
  const d = fresh();
  tm.applyTimerConfig(d, { durationMs: 30 * MIN, endAtTarget: '14:30', endAtTzOffsetMin: BST }, NOW);
  tm.applyTimerConfig(d, { timerMode: 'duration' }, NOW);
  tm.startTimer(d, {}, NOW);
  d.mode = 'paused'; d.pauseTime = NOW + 5 * MIN;
  tm.applyTimerConfig(d, { timerMode: 'endAt' }, NOW + 6 * MIN);
  tm.resumeTimer(d, NOW + 15 * MIN);
  assert.equal(d.accumulatedPauseMs, 10 * MIN);
});

test('End-at: a live nudge moves the absolute finish and survives pause/resume; Reset and rundown Take clear it', () => {
  const s = fresh({ rundown: [{ name: 'A', durationMs: 5 * MIN }] });
  tm.applyTimerConfig(s, { endAtTarget: '14:30', endAtTzOffsetMin: BST }, NOW);
  tm.startTimer(s, {}, NOW);
  tm.nudge(s, 2 * MIN, NOW + MIN);
  assert.equal(s.runEndAtMs, NOW + 32 * MIN);
  s.mode = 'paused'; s.pauseTime = NOW + 5 * MIN;
  tm.resumeTimer(s, NOW + 15 * MIN);
  assert.equal(s.startTime + s.accumulatedPauseMs + s.durationMs, NOW + 32 * MIN);
  tm.resetTimer(s, NOW + 16 * MIN);
  assert.equal(s.runEndAtMs, null);
  tm.startTimer(s, {}, NOW + 16 * MIN);
  assert.ok(Number.isFinite(s.runEndAtMs));
  tm.loadRundownItem(s, 0, false, NOW + 17 * MIN);
  assert.equal(s.runEndAtMs, null);
});

test('applyEndAt (stopped): commits target + mode + time-to-target; does not start anything', () => {
  const s = fresh();
  assert.deepEqual(tm.applyEndAt(s, { endAtTarget: '14:30', endAtTzOffsetMin: BST }, NOW), { ok: true });
  assert.equal(s.timerMode, 'endAt');
  assert.equal(s.endAtTarget, '14:30');
  assert.equal(s.durationMs, 30 * MIN);
  assert.equal(s.mode, 'stopped');
  assert.equal(s.runEndAtMs == null, true);
});

test('applyEndAt: invalid / incomplete values are refused and change NOTHING', () => {
  for (const bad of [undefined, null, {}, { endAtTarget: '' }, { endAtTarget: '14:' }, { endAtTarget: '25:00' }, { endAtTarget: 'ab:cd' }, { endAtTarget: 1430 }]) {
    const s = fresh();
    tm.applyTimerConfig(s, { endAtTarget: '14:30', endAtTzOffsetMin: BST }, NOW);
    tm.startTimer(s, {}, NOW);
    const before = JSON.stringify(s);
    assert.equal(tm.applyEndAt(s, bad, NOW + MIN).ok, false, JSON.stringify(bad));
    assert.equal(JSON.stringify(s), before, 'state untouched for ' + JSON.stringify(bad));
  }
});

test('applyEndAt (running, from a Duration run): re-targets the live run atomically to the absolute target', () => {
  const s = fresh();
  tm.applyTimerConfig(s, { durationMs: 10 * MIN }, NOW);
  tm.startTimer(s, {}, NOW);
  const at = NOW + 2 * MIN; // 2 min in; 8 min left before
  assert.equal(tm.applyEndAt(s, { endAtTarget: '14:30', endAtTzOffsetMin: BST }, at).ok, true);
  assert.equal(s.mode, 'running');
  assert.equal(s.startTime, NOW, 'run not restarted');
  assert.equal(s.runEndAtMs, NOW + 30 * MIN);
  assert.equal(s.startTime + s.accumulatedPauseMs + s.durationMs / s.speed, NOW + 30 * MIN, 'finish = target');
  assert.equal(s.durationMs - (at - s.startTime - s.accumulatedPauseMs) * s.speed, 28 * MIN, 'remaining = target - now');
});

test('applyEndAt (running, speed 2): finish still lands on the wall-clock target', () => {
  const s = fresh({ speed: 2 });
  tm.applyTimerConfig(s, { durationMs: 10 * MIN }, NOW);
  tm.startTimer(s, {}, NOW);
  tm.applyEndAt(s, { endAtTarget: '14:30', endAtTzOffsetMin: BST }, NOW + MIN);
  assert.equal(s.startTime + s.accumulatedPauseMs + s.durationMs / 2, NOW + 30 * MIN);
});

test('applyEndAt (paused): frozen remaining is "as of now"; Resume then keeps the fixed target (ab9d70d semantics)', () => {
  const s = fresh();
  tm.applyTimerConfig(s, { endAtTarget: '14:30', endAtTzOffsetMin: BST }, NOW);
  tm.startTimer(s, {}, NOW);
  s.mode = 'paused'; s.pauseTime = NOW + 5 * MIN;
  const at = NOW + 10 * MIN;
  tm.applyEndAt(s, { endAtTarget: '14:45', endAtTzOffsetMin: BST }, at); // new target = NOW + 45 min
  assert.equal(s.mode, 'paused');
  assert.equal(s.runEndAtMs, NOW + 45 * MIN);
  assert.equal(s.durationMs - (s.pauseTime - s.startTime - s.accumulatedPauseMs) * s.speed, 35 * MIN, 'paused display = target - now');
  tm.resumeTimer(s, NOW + 20 * MIN);
  assert.equal(s.startTime + s.accumulatedPauseMs + s.durationMs / s.speed, NOW + 45 * MIN, 'finish stays the target after Resume');
  assert.equal(s.durationMs - (NOW + 20 * MIN - s.startTime - s.accumulatedPauseMs) * s.speed, 25 * MIN);
});

test('applyEndAt: a target at or before now means tomorrow', () => {
  const s = fresh();
  tm.applyTimerConfig(s, { durationMs: 10 * MIN }, NOW);
  tm.startTimer(s, {}, NOW);
  tm.applyEndAt(s, { endAtTarget: '13:59', endAtTzOffsetMin: BST }, NOW);
  assert.equal(s.runEndAtMs, NOW + (24 * 60 - 1) * MIN);
});

'use strict';

// Timer mode model (Duration / End at).
//
// State fields (all on the room's timerState, all server-authoritative):
//   timerMode        'duration' | 'endAt'  - which configuration Start/Reset use
//   configDurationMs the operator's Duration-mode value; preserved while End at
//                    is the active mode so switching back never loses it
//   endAtTarget      'HH:MM' clock target, or null; preserved while Duration is
//                    the active mode, and across Reset
//   endAtTzOffsetMin the operator's Date#getTimezoneOffset() when the target was
//                    set, so 'HH:MM' means the operator's wall clock even when
//                    the server (e.g. Railway) runs in UTC
//   runEndAtMs       epoch ms a running/paused End-at run must finish at (absolute
//                    wall-clock target); null for Duration runs. Set at Start.
//   durationMs       (pre-existing) length of the current/next run. While
//                    stopped it always equals what Start would run: the
//                    configured duration, or time-to-target for End at.
//
// Every function mutates the passed state and returns it. None of them touch
// startTime/pauseTime/accumulatedPauseMs except start/resume/reset, which own them.

const HHMM = /^(\d{1,2}):(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseEndAt(value) {
  if (typeof value !== 'string') return null;
  const m = HHMM.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { h, min, text: `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}` };
}

// Milliseconds from nowMs until the next occurrence of `target` ('HH:MM') on
// the operator's wall clock. A target at or before "now" means tomorrow
// (existing product behaviour). Returns null for an invalid target.
function endAtDurationMs(target, tzOffsetMin, nowMs) {
  const t = parseEndAt(target);
  if (!t) return null;
  const off = Number.isFinite(tzOffsetMin) ? tzOffsetMin : new Date(nowMs).getTimezoneOffset();
  const local = new Date(nowMs - off * 60000); // UTC getters now read as operator wall clock
  let targetMs = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), t.h, t.min, 0, 0) + off * 60000;
  if (targetMs <= nowMs) targetMs += DAY_MS;
  return targetMs - nowMs;
}

function configDuration(state) {
  return Number.isFinite(state.configDurationMs) ? state.configDurationMs : (state.durationMs || 0);
}

// Legacy/persisted states predate the mode fields; adopt their current
// duration as the configured one so Reset does not jump to a default.
function normalizeState(state) {
  if (state.timerMode !== 'duration' && state.timerMode !== 'endAt') state.timerMode = 'duration';
  if (!Number.isFinite(state.configDurationMs)) state.configDurationMs = state.durationMs || 0;
  if (parseEndAt(state.endAtTarget) === null) state.endAtTarget = null;
  return state;
}

// While stopped, durationMs must equal what Start would run.
function syncStoppedDuration(state, nowMs) {
  if (state.mode !== 'stopped') return state;
  if (state.timerMode === 'endAt') {
    const ms = endAtDurationMs(state.endAtTarget, state.endAtTzOffsetMin, nowMs);
    if (ms === null) state.timerMode = 'duration'; // End at without a valid target cannot be active
    else { state.durationMs = ms; return state; }
  }
  state.durationMs = configDuration(state);
  return state;
}

function setDuration(state, ms, nowMs) {
  const v = Math.max(0, Math.floor(ms));
  state.configDurationMs = v;
  state.durationMs = v;
  state.timerMode = 'duration';
  return syncStoppedDuration(state, nowMs);
}

// Config from updateSettings / startTimer. Recognised fields:
//   timerMode, endAtTarget, endAtTzOffsetMin, durationMs
// Mode resolution: explicit timerMode wins; otherwise an explicit durationMs
// means Duration and an explicit valid endAtTarget means End at (legacy
// clients send just one of them). Only the *configuration* changes while
// running/paused - the live run keeps its length until Reset/Start.
function applyTimerConfig(state, data, nowMs) {
  normalizeState(state);
  const hasDuration = typeof data.durationMs === 'number' && Number.isFinite(data.durationMs) && data.durationMs >= 0;

  if (data.endAtTarget !== undefined) {
    const t = parseEndAt(data.endAtTarget);
    if (t) {
      state.endAtTarget = t.text;
      if (Number.isFinite(data.endAtTzOffsetMin)) state.endAtTzOffsetMin = data.endAtTzOffsetMin;
    }
  }

  let requested = data.timerMode === 'duration' || data.timerMode === 'endAt' ? data.timerMode : null;
  if (!requested) {
    if (hasDuration) requested = 'duration';
    else if (data.endAtTarget !== undefined && parseEndAt(data.endAtTarget)) requested = 'endAt';
  }

  if (hasDuration && requested !== 'endAt') {
    state.configDurationMs = Math.floor(data.durationMs);
    if (state.mode !== 'stopped') state.durationMs = state.configDurationMs; // legacy: live edit
  }
  if (requested === 'endAt') {
    if (state.endAtTarget) state.timerMode = 'endAt'; // ignored without a target
  } else if (requested === 'duration') {
    state.timerMode = 'duration';
  }
  return syncStoppedDuration(state, nowMs);
}

// Start: apply any config sent with the command, then fix the run length.
function startTimer(state, data, nowMs) {
  applyTimerConfig(state, data || {}, nowMs);
  if (state.timerMode === 'endAt') {
    const ms = endAtDurationMs(state.endAtTarget, state.endAtTzOffsetMin, nowMs);
    if (ms === null) state.timerMode = 'duration';
    else state.durationMs = ms;
  }
  state.runEndAtMs = state.timerMode === 'endAt' ? nowMs + state.durationMs / (state.speed || 1) : null;
  state.mode = 'running';
  state.startTime = nowMs;
  state.pauseTime = null;
  state.accumulatedPauseMs = 0;
  return state;
}

// Resume. Duration run: the pause shifts the finish later (accumulate the pause).
// End-at run: the finish is an absolute wall-clock target, so pausing only freezes
// the display; on resume the timer catches up to the target (elapsed jumps forward
// by the pause length, or goes into overrun if the target passed meanwhile).
function resumeTimer(state, nowMs) {
  if (state.mode !== 'paused') return state;
  if (Number.isFinite(state.runEndAtMs)) {
    state.accumulatedPauseMs = state.runEndAtMs - state.startTime - state.durationMs / (state.speed || 1);
  } else if (state.pauseTime) {
    state.accumulatedPauseMs += nowMs - state.pauseTime;
  }
  state.pauseTime = null;
  state.mode = 'running';
  return state;
}

// Reset returns to the configured value of the active mode. The end-at target
// is kept (it is configuration, not run state).
function resetTimer(state, nowMs) {
  normalizeState(state);
  state.mode = 'stopped';
  state.startTime = null;
  state.pauseTime = null;
  state.accumulatedPauseMs = 0;
  state.runEndAtMs = null;
  return syncStoppedDuration(state, nowMs);
}

// Nudge. Running/paused: adjusts this run only (existing behaviour). Stopped:
// the nudged value becomes the configured Duration - a stopped End at timer
// nudged by +1 min becomes "time-to-target + 1 min" as a fixed Duration, since
// Start would otherwise recompute from the clock and silently discard it.
function nudge(state, deltaMs, nowMs) {
  normalizeState(state);
  const delta = Math.trunc(deltaMs);
  if (state.mode === 'stopped') {
    syncStoppedDuration(state, nowMs);
    return setDuration(state, Math.max(0, state.durationMs + delta), nowMs);
  }
  const before = state.durationMs || 0;
  state.durationMs = Math.max(0, before + delta);
  // An End-at run's absolute finish moves with the nudge (by what was actually
  // applied), so the nudge survives pause/resume.
  if (Number.isFinite(state.runEndAtMs)) state.runEndAtMs += (state.durationMs - before) / (state.speed || 1);
  return state;
}

// Selecting/taking a rundown item: its duration becomes the Duration config and
// Duration becomes the active mode. Any End at target is cleared (existing
// behaviour) so it cannot silently reappear later.
function loadRundownItem(state, index, autoStart, nowMs) {
  const item = state.rundown[index];
  state.rundownIndex = index;
  state.endAtTarget = null;
  state.configDurationMs = item.durationMs;
  state.durationMs = item.durationMs;
  state.timerMode = 'duration';
  state.startTime = autoStart ? nowMs : null;
  state.pauseTime = null;
  state.accumulatedPauseMs = 0;
  state.runEndAtMs = null;
  state.mode = autoStart ? 'running' : 'stopped';
  return state;
}

module.exports = {
  parseEndAt,
  endAtDurationMs,
  normalizeState,
  syncStoppedDuration,
  setDuration,
  applyTimerConfig,
  startTimer,
  resumeTimer,
  resetTimer,
  nudge,
  loadRundownItem,
};

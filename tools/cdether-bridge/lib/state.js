'use strict';

// Pure state -> CDEther frame derivation.
//
// The remaining-time maths deliberately mirrors public/display.html
// (updateTimerDisplay) so the physical Hive display and the browser display
// screen always agree to the second. The colour rules use the ROOM'S OWN
// amber/red thresholds (same as display.html and the /companion endpoint) -
// nothing here is hard-coded to 10s/5s.
//
// No independent timer: every value is a deterministic function of the latest
// authoritative timerState anchors + the server clock offset + wall-clock now.

// Four BCD digits can only show up to 99:59.
const MAX_MINUTES = 99;

/**
 * Replicates display.html's remaining-time computation.
 * `nowCorrectedMs` must already have the server clock offset applied.
 */
function computeRemaining(s, nowCorrectedMs) {
  let remainingMs = s.durationMs || 0;
  let finished = false;

  if (s.startTime) {
    const speed = s.speed || 1.0;
    const accumulatedPauseMs = s.accumulatedPauseMs || 0;
    const pausedOffset = s.pauseTime
      ? (s.pauseTime - s.startTime) - accumulatedPauseMs
      : (nowCorrectedMs - s.startTime) - accumulatedPauseMs;
    const elapsedMs = Math.max(0, pausedOffset) * speed;
    remainingMs = s.durationMs - elapsedMs;

    if (remainingMs <= 0) {
      finished = true;
      remainingMs = 0; // POC: overtime/count-up is unverified on CDEther -> hold 00:00
    }
  }

  return { remainingMs, finished };
}

/**
 * ms -> {minutes, seconds, hoursMode}, floored like display.html.
 *
 * Past 99:59 (4 BCD digits can't represent more), switch to sending H:MM
 * through the same two fields instead of clamping/holding at 99:59 - the
 * hardware has no unit semantics of its own for these two bytes; this is the
 * exact same trick Time of Day / clock mode already uses and has physically
 * verified (deriveFrame below sends {minutes: getHours(), seconds:
 * getMinutes()} for the clock - see RIG-REGRESSION.md), just fed the
 * countdown's hours/minutes instead of the wall clock's. No seconds are shown
 * once in hours mode. `hoursMode` lets callers (deriveFrame, bridge.js's
 * console log) tell the two apart for logging/labelling - the raw bytes on
 * the wire are identical either way.
 */
function clampToDisplay(ms) {
  const totalSec = Math.floor(Math.max(0, ms) / 1000);
  const totalMinutes = Math.floor(totalSec / 60);
  if (totalMinutes > MAX_MINUTES) {
    return { minutes: Math.floor(totalMinutes / 60), seconds: totalMinutes % 60, hoursMode: true };
  }
  return { minutes: totalMinutes, seconds: totalSec % 60, hoursMode: false };
}

/**
 * @param {object} s              latest authoritative timerState
 * @param {number} nowMs          Date.now()
 * @param {number} clockOffsetMs  serverNow - Date.now(), captured when the state arrived
 * @param {{idleBehaviour?: 'duration'|'off'}} opts
 * @returns {{minutes:number, seconds:number, colour:'green'|'red'|'amber'|'off',
 *            finished?:boolean, remainingMs?:number, hoursMode?:boolean, reason:string}}
 */
function deriveFrame(s, nowMs, clockOffsetMs = 0, opts = {}) {
  const idleBehaviour = opts.idleBehaviour || 'duration';
  const off = (reason) => ({ minutes: 0, seconds: 0, colour: 'off', reason });

  // --- non-timer display states ---
  // Overlay message hides the timer entirely on the real display screen ->
  // OFF (byte 3 = 0x04). Checked first so it also overrides clock mode.
  if (s.messageMode === 'overlay' && s.message) return off('overlay-message');

  const nowCorrected = nowMs + (clockOffsetMs || 0);

  // Time-of-day / clock mode (P1.1, rig-proven): ordinary four-digit BCD
  // frames already render arbitrary values correctly (12:00 / 23:59 / 00:00 /
  // 09:05 confirmed on the rig) - no new frame values, same encoding as the
  // countdown path. 24-hour, always green, no colon/blink/brightness (all
  // unverified and out of scope). Uses the server-corrected clock (same basis
  // as every other frame in this file), in the bridge machine's local
  // timezone. Native leading-zero suppression (e.g. "9:05") is accepted
  // physical-display behaviour, not something this code needs to handle.
  if (s.showClock || s.outputMode === 'clock') {
    const d = new Date(nowCorrected);
    return { minutes: d.getHours(), seconds: d.getMinutes(), colour: 'green', reason: 'clock' };
  }

  const idle = s.mode === 'stopped' || !s.startTime;
  if (idle && idleBehaviour === 'off') return off('idle-off');

  // --- normal timer output ---
  const { remainingMs, finished } = computeRemaining(s, nowCorrected);

  const amber = Number.isFinite(s.amberThresholdMs) ? s.amberThresholdMs : 0;
  const red = Number.isFinite(s.redThresholdMs) ? s.redThresholdMs : 0;

  let colour;
  if (finished) {
    colour = 'red'; // finished countdown (and unverified overtime) -> 00:00 red
  } else if (remainingMs <= red) {
    colour = 'red';
  } else if (remainingMs <= amber) {
    colour = 'amber';
  } else {
    colour = 'green';
  }

  const { minutes, seconds, hoursMode } = clampToDisplay(finished ? 0 : remainingMs);
  return {
    minutes,
    seconds,
    colour,
    finished,
    remainingMs,
    hoursMode,
    reason: idle ? 'idle-duration' : s.mode,
  };
}

module.exports = { deriveFrame, computeRemaining, clampToDisplay };

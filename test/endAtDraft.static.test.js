'use strict';

// Static guard for the staged End-at model (no browser infra in the repo): the
// End-at field is a draft, so nothing bound to typing / blur / focus / change on
// it may talk to the server. The only server call is 'applyEndAt', reached from
// applyEndAtDraft (Set button or Enter). Behaviour is also verified in a real
// browser - see TIMER-MODES.md checklist.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'control.html'), 'utf8').replace(/\r\n/g, '\n');

function functionBody(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} not found`);
  let depth = 0; let i = html.indexOf('{', start);
  const from = i;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) break;
  }
  return html.slice(from, i + 1);
}

test('sendEndAt is the only place that emits applyEndAt, reached only from applyEndAtDraft (Set/Enter), commitStagedConfig (Reset) and startTimer (Start) - each with its own validity/dirty guard, never unconditionally', () => {
  const emits = html.match(/\.emit\('applyEndAt'/g) || [];
  assert.equal(emits.length, 1);
  assert.ok(functionBody('sendEndAt').includes(".emit('applyEndAt'"));
  for (const caller of ['applyEndAtDraft', 'commitStagedConfig', 'startTimer']) {
    assert.ok(functionBody(caller).includes('sendEndAt('), `${caller} must reach sendEndAt`);
  }
  // defined once + exactly the three call sites above - no other path exists
  assert.equal((html.match(/sendEndAt\(/g) || []).length, 4, 'defined once, called from exactly 3 places');
});

test('no End-at field listener (input/change/blur/focus/keydown other than Enter) or draft helper emits to the server', () => {
  for (const fn of ['refreshEndAtDraftUI', 'cancelEndAtDraft', 'fmtRemaining', 'liveRemainingMs', 'proposeEndAt']) {
    assert.ok(!/socket\.emit/.test(functionBody(fn)), `${fn} must not emit`);
  }
  const inputListener = html.match(/endAtEl\.addEventListener\('input'[^\n]*/)[0];
  assert.match(inputListener, /refreshEndAtDraftUI/);
  assert.ok(!/emit/.test(inputListener));
  assert.ok(!/addEventListener\('(blur|focus|focusout|change)'/.test(html.slice(html.indexOf('let endAtDirty'), html.indexOf('// Connect using the control token'))), 'no blur/focus/change handler on the draft');
});

test('Start never sends an endAtTarget of its own - only the server\'s last applied/committed one, or a draft explicitly validated and committed first', () => {
  assert.ok(!/endAtTarget:\s*(document|endAtEl)/.test(functionBody('startTimer')), 'no endAtTarget built directly into the startTimer payload');
  assert.ok(!/endAtTarget: document/.test(html), 'no payload anywhere built from a raw field read');
});

test('setTimerMode(\'endAt\') requires the field to hold a VALID time (committed or freshly typed) before switching tabs - never an empty/incomplete one', () => {
  const body = functionBody('setTimerMode');
  assert.match(body, /!isValidEndAt\(endAtEl\.value\)/, 'gated on validity, not literally reading .value to configure anything');
  assert.match(body, /endAtTime'\)\.focus\(\)/, 'refuses (focuses the field) rather than silently switching to nothing');
});

test('a state sync never overwrites an unapplied draft', () => {
  assert.match(html, /if \(!endAtDirty\) endAtEl\.value = state\.endAtTarget/);
});

test('the Apply button starts disabled and the generic input handler skips the End-at field', () => {
  assert.match(html, /id="endAtApplyBtn"[^>]*\bdisabled\b/);
  assert.match(html, /input\.id === 'duration' \|\| input\.id === 'endAtTime'\) return/);
});

test('shared Timer Setup editor: the view helpers are UI-only - none of them emits', () => {
  for (const fn of ['timerSetupView', 'renderTimerModeView', 'armEndAtIfPending', 'updateEndTimeCalc', 'fmtDurationMs']) {
    assert.ok(!/socket\.emit|\.emit\(/.test(functionBody(fn)), `${fn} must not emit`);
  }
});

test('opening End at with no valid time only shows its editor - it never arms End at (Start/Reset keep using Duration)', () => {
  const body = functionBody('setTimerMode');
  const refusal = body.slice(0, body.indexOf('return;'));
  assert.match(refusal, /endAtViewPending = true/);
  assert.ok(!/currentTimerMode\s*=|modeTouched\s*=/.test(refusal), 'the refusal branch must not change the armed mode');
  // arming happens only once the field holds a valid time, and goes back through setTimerMode's own validity gate
  assert.match(functionBody('armEndAtIfPending'), /endAtViewPending && isValidEndAt\(endAtEl\.value\)\) setTimerMode\('endAt'\)/);
});

test('live End-at retarget asks via the in-page modal (not window.confirm), and Confirm only sends what was confirmed', () => {
  const apply = functionBody('applyEndAtDraft');
  assert.ok(!/\bconfirm\(/.test(apply), 'no blocking window.confirm');
  assert.match(apply, /openEndAtConfirm\(v, send\);[^\n]*\n\s*return;/, 'a live change opens the modal and returns without sending');
  for (const fn of ['openEndAtConfirm', 'closeEndAtConfirm', 'renderEndAtConfirm']) {
    assert.ok(!/socket\.emit|sendEndAt\(/.test(functionBody(fn)), `${fn} must not send`);
  }
  const confirmBody = functionBody('confirmEndAtChange');
  assert.match(confirmBody, /endAtEl\.value !== pending\.v/, 're-checks the draft is unchanged before sending');
  assert.match(functionBody('setViewOnly'), /closeEndAtConfirm\(\)/, 'losing control abandons an open confirmation');
});

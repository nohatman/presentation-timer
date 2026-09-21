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

test('the only place that emits applyEndAt is applyEndAtDraft', () => {
  const emits = html.match(/\.emit\('applyEndAt'/g) || [];
  assert.equal(emits.length, 1);
  assert.ok(functionBody('sendEndAt').includes(".emit('applyEndAt'"));
  assert.ok(functionBody('applyEndAtDraft').includes('sendEndAt('), 'reached only via applyEndAtDraft');
  assert.equal((html.match(/sendEndAt\(/g) || []).length, 2, 'defined once, called once (from applyEndAtDraft)');
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

test('Start and mode buttons never read the draft field value', () => {
  assert.ok(!/getElementById\('endAtTime'\)\.value/.test(functionBody('startTimer')));
  assert.ok(!/getElementById\('endAtTime'\)\.value/.test(functionBody('setTimerMode')));
  assert.ok(!/endAtTarget: document/.test(html), 'no payload built from the field');
});

test('a state sync never overwrites an unapplied draft', () => {
  assert.match(html, /if \(!endAtDirty\) endAtEl\.value = state\.endAtTarget/);
});

test('the Apply button starts disabled and the generic input handler skips the End-at field', () => {
  assert.match(html, /id="endAtApplyBtn"[^>]*\bdisabled\b/);
  assert.match(html, /input\.id === 'duration' \|\| input\.id === 'endAtTime'\) return/);
});

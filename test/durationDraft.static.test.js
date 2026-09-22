'use strict';

// Static guard for the staged Duration model (no browser infra in the repo, same
// approach as endAtDraft.static.test.js): typing in the Duration field, or
// clicking a preset, or clicking a mode tab, while STOPPED must never talk to the
// server on their own - only Set (or Enter) does. This is what stops a value the
// operator is still choosing from flashing onto a connected Display/CDEther before
// they've decided. Editing while running/paused remains unsupported (unchanged -
// use the nudge buttons), so Set is a no-op then, with no draft/confirmation
// complexity needed for that case. Behaviour is also verified in a real browser -
// see TIMER-MODES.md checklist.

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

test('the only place that emits updateSettings({durationMs}) for a STOPPED timer is applyDurationDraft', () => {
  assert.ok(functionBody('applyDurationDraft').includes("socket.emit('updateSettings', { durationMs: getDurationMs() })"));
  // handleDurationInput (every keystroke) and the draft helpers must never emit
  for (const fn of ['handleDurationInput', 'refreshDurationDraftUI', 'cancelDurationDraft']) {
    assert.ok(!/socket\.emit/.test(functionBody(fn)), `${fn} must not emit`);
  }
  // applyPreset's STOPPED branch (after its early-return for the running case) must not emit
  const presetBody = functionBody('applyPreset');
  const stoppedBranch = presetBody.slice(presetBody.indexOf('return;') + 'return;'.length);
  assert.ok(!/socket\.emit/.test(stoppedBranch), 'a preset click while stopped must only stage, never emit');
});

test('mode tab buttons (Duration/End At) are local-only and never emit to the server', () => {
  assert.ok(!/socket\.emit/.test(functionBody('setTimerMode')), 'setTimerMode must not emit - switching tabs must not touch a connected Display/CDEther');
});

test('typing/blur/focus on the Duration field never applies - only input(stage)/keydown(Enter=Set) are bound, and blur does not emit', () => {
  const inputListener = html.match(/durationEl\.addEventListener\('input'[^\n]*/)[0];
  assert.match(inputListener, /handleDurationInput/);
  assert.ok(!/emit/.test(inputListener));
  const keydownListener = html.match(/durationEl\.addEventListener\('keydown'[\s\S]*?\}\);/)[0];
  assert.match(keydownListener, /applyDurationDraft/);
  const blurBlock = html.slice(html.indexOf("durationEl.addEventListener('blur'"), html.indexOf("durationEl.addEventListener('blur'") + 500);
  assert.ok(!/socket\.emit/.test(blurBlock.slice(0, blurBlock.indexOf('});'))), 'blur must not itself emit');
});

test('a state sync never overwrites an unapplied Duration draft', () => {
  assert.match(html, /if \(!durationInputFocused && !durationDirty\)/);
});

test('the Duration Set button starts disabled; the generic settings-input listener skips the Duration field', () => {
  assert.match(html, /id="durationApplyBtn"[^>]*\bdisabled\b/);
  assert.match(html, /input\.id === 'duration' \|\| input\.id === 'endAtTime'\) return/);
});

test('Start still reads the live Duration field directly (staging is about the DISPLAY, not about blocking Start)', () => {
  assert.match(functionBody('startTimer'), /data\.durationMs = getDurationMs\(\)/);
});

test('a preset click on a RUNNING/PAUSED timer keeps its previous immediate behaviour (reset + apply) - unchanged, not staged', () => {
  const presetBody = functionBody('applyPreset');
  assert.match(presetBody, /if \(currentState\.mode !== 'stopped'\) \{[\s\S]*?resetTimer[\s\S]*?updateSettings[\s\S]*?return;/);
});

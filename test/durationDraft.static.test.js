'use strict';

// Static guard for the staged Duration model (no browser infra in the repo, same
// approach as endAtDraft.static.test.js): typing in the Duration field, clicking a
// preset, or clicking a mode tab must never talk to the server on their own -
// ALWAYS, whatever the timer's current state (running/paused/stopped). This is
// what stops a value the operator is still choosing from flashing onto a
// connected Display/CDEther before they've decided.
//
// While stopped, Set (or Enter) applies a Duration draft directly. While running/
// paused, Duration editing has no live-apply of its own (unlike End At) - instead
// Reset and Start both silently commit whatever is currently staged (in whichever
// tab is active) before they act, via commitStagedConfig - so "stage a preset,
// then Reset (or Start)" is how a live timer picks up a new value, deliberately,
// never automatically from the preset/typing itself. Behaviour is also verified
// in a real browser - see TIMER-MODES.md checklist.

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

test('nothing bound to typing/clicking a preset/switching tabs ever emits - staging is unconditional, not just while stopped', () => {
  for (const fn of ['handleDurationInput', 'refreshDurationDraftUI', 'cancelDurationDraft', 'applyPreset', 'setTimerMode']) {
    assert.ok(!/socket\.emit/.test(functionBody(fn)), `${fn} must not emit`);
  }
});

test('applyPreset always stages (setTimerMode + refreshDurationDraftUI), unconditionally - no mode/state branch left over', () => {
  const body = functionBody('applyPreset');
  assert.match(body, /setTimerMode\('duration'\)/);
  assert.match(body, /refreshDurationDraftUI\(\)/);
  assert.ok(!/if\s*\(\s*currentState\.mode/.test(body), 'must not special-case running/paused any more');
});

test('the ONLY place that emits updateSettings({durationMs}) for a stopped timer directly is applyDurationDraft (Set)', () => {
  assert.ok(functionBody('applyDurationDraft').includes("socket.emit('updateSettings', { durationMs: getDurationMs() })"));
});

test('commitStagedConfig is the single place Reset/Start pick up a pending draft, and it never shows a confirmation dialog', () => {
  const body = functionBody('commitStagedConfig');
  assert.match(body, /sendEndAt\(endAtEl\.value\)/, 'End At branch: commits via sendEndAt, not the confirming applyEndAtDraft');
  assert.ok(!/applyEndAtDraft|confirm\(/.test(body), 'must not go through the live-retarget confirmation path');
  assert.match(body, /modeTouched \|\| durationDirty/, 'Duration branch: fires on either a switched tab or an edited value');
  assert.match(body, /timerMode: 'duration'/);
});

test('resetTimer commits the active draft first, then resets', () => {
  const body = functionBody('resetTimer');
  const commitAt = body.indexOf('commitStagedConfig()');
  const resetAt = body.indexOf("socket.emit('resetTimer')");
  assert.ok(commitAt !== -1 && resetAt !== -1 && commitAt < resetAt, 'commit must happen before the reset emit');
});

test('startTimer: Duration is self-contained (sends durationMs directly); End At commits a pending valid draft first, then starts', () => {
  const body = functionBody('startTimer');
  assert.match(body, /data\.durationMs = getDurationMs\(\)/, 'Duration already sends the box value directly - no separate commit needed');
  assert.match(body, /isValidEndAt\(endAtEl\.value\)\) sendEndAt\(endAtEl\.value\)/, 'End At: commits a valid draft before starting');
  assert.ok(!/applyEndAtDraft|confirm\(/.test(body), 'no confirmation dialog - Start only ever fires from a stopped timer');
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

test('a state sync never overwrites an unapplied Duration draft, in ANY run state (the dirty check no longer requires stopped)', () => {
  assert.match(html, /if \(!durationInputFocused && !durationDirty\)/);
  assert.ok(!/durationDirty = currentState\.mode === 'stopped' &&/.test(html), 'dirty tracking must not be gated to stopped any more');
});

test('the Duration Set button is disabled while dirty tracking is unconditional, but the button itself still only applies while stopped', () => {
  assert.match(html, /id="durationApplyBtn"[^>]*\bdisabled\b/);
  assert.match(functionBody('refreshDurationDraftUI'), /durationApplyBtn'\)\.disabled = !durationDirty \|\| currentState\.mode !== 'stopped'/);
  assert.match(functionBody('applyDurationDraft'), /if \(currentState\.mode !== 'stopped' \|\| !durationDirty\) return;/);
  assert.match(html, /input\.id === 'duration' \|\| input\.id === 'endAtTime'\) return/);
});

'use strict';

// Static guard for the Home/Fullscreen auto-hide on the Display page (no browser
// infra in the repo - see localServer/endAtDraft static tests for the same
// approach). Real-browser behaviour (fade out on idle, fade back in on pointer
// activity, buttons still work) was verified manually; this just pins the pieces
// that make it work so a future edit can't silently break one of them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'display.html'), 'utf8').replace(/\r\n/g, '\n');

test('idle-hide CSS: both control containers fade out and become unclickable under body.controls-idle', () => {
  const rule = html.match(/body\.controls-idle[\s\S]*?\{[\s\S]*?\}/)[0];
  assert.match(rule, /\.controls/);
  assert.match(rule, /\.settings/);
  assert.match(rule, /opacity:\s*0/);
  assert.match(rule, /pointer-events:\s*none/);
});

test('pointer activity (move, down, touch) shows the controls and restarts the idle timer', () => {
  assert.match(html, /\['pointermove', 'pointerdown', 'touchstart'\]/);
  assert.match(html, /classList\.remove\('controls-idle'\)/);
  assert.match(html, /classList\.add\('controls-idle'\)/);
});

test('controls are visible on load (idle countdown starts, not already hidden)', () => {
  assert.match(html, /showControls\(\);\s*\/\/ visible on load/);
});

test('Home and Fullscreen buttons themselves are untouched (still call the same handlers)', () => {
  assert.match(html, /onclick="window\.open\('\/', '_blank'\)">Home</);
  assert.match(html, /onclick="toggleFullscreen\(\)">Fullscreen</);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeDeviceName, MAX_DEVICE_NAME_LENGTH } = require('../deviceNames');

const ch = (...cps) => String.fromCodePoint(...cps); // invisible characters built explicitly, never pasted in

test('keeps ordinary names, trims and collapses whitespace', () => {
  assert.equal(sanitizeDeviceName("Peter's iPad"), "Peter's iPad");
  assert.equal(sanitizeDeviceName('  Amber   Otter \n'), 'Amber Otter');
  assert.equal(sanitizeDeviceName('Régie ' + ch(0x1f3ac) + ' FOH'), 'Régie ' + ch(0x1f3ac) + ' FOH');
});

test('non-strings and empty/blank values become null (caller falls back to "another panel")', () => {
  for (const v of [undefined, null, 42, {}, [], '', '   ', ch(0x200b, 0x200b)]) {
    assert.equal(sanitizeDeviceName(v), null, JSON.stringify(v));
  }
});

test('strips control characters, zero-width characters, line separators and bidi overrides', () => {
  assert.equal(sanitizeDeviceName('Pe' + ch(0) + 'ter' + ch(7)), 'Peter');
  assert.equal(sanitizeDeviceName('Pe' + ch(0x200b) + 'ter'), 'Peter');
  assert.equal(sanitizeDeviceName('Pe' + ch(0x2028) + 'ter'), 'Peter');
  assert.equal(sanitizeDeviceName(ch(0x202e) + 'evil' + ch(0x202c) + ' name'), 'evil name');
});

test('HTML is kept as plain text (the page renders names with textContent, never innerHTML)', () => {
  assert.equal(sanitizeDeviceName('<b>Peter</b>'), '<b>Peter</b>');
});

test(`caps at ${MAX_DEVICE_NAME_LENGTH} characters without splitting an emoji`, () => {
  assert.equal(sanitizeDeviceName('x'.repeat(100)).length, MAX_DEVICE_NAME_LENGTH);
  const clapper = ch(0x1f3ac);
  const out = sanitizeDeviceName(clapper.repeat(MAX_DEVICE_NAME_LENGTH + 5));
  assert.equal(Array.from(out).length, MAX_DEVICE_NAME_LENGTH);
  assert.ok(Array.from(out).every(c => c === clapper), 'no half surrogate pairs');
});

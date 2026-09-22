'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const RT = require('../public/rundownText');

const MIN = 60000;
const item = (name, mins, secs = 0) => ({ name, durationMs: (mins * 60 + secs) * 1000 });

test('format: one "Name, MM:SS" line per item, order preserved, no trailing newline', () => {
  const text = RT.format([item('Welcome', 5), item('Opening Remarks', 15), item('Session One', 40, 30)]);
  assert.equal(text, 'Welcome, 05:00\nOpening Remarks, 15:00\nSession One, 40:30');
  assert.equal(RT.format([]), '');
});

test('parse: the historical formats still work (name only, MM:SS, plain minutes, comma in name)', () => {
  const r = RT.parse('Jane Smith, 20:00\nPanel, 45\nNo time given\nSmith, John, 7:30\nHalf, 2.5');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.items, [
    item('Jane Smith', 20), item('Panel', 45), { name: 'No time given', durationMs: RT.DEFAULT_MS },
    item('Smith, John', 7, 30), item('Half', 2, 30),
  ]);
});

test('parse: blank lines, whitespace, CRLF, BOM and a missing final newline are all harmless', () => {
  const r = RT.parse('﻿  A , 1:00  \r\n\r\n   \r\n\tB,2:00\r\nC, 3:00');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.items, [item('A', 1), item('B', 2), item('C', 3)]);
  assert.equal(r.blankLines, 2);
  assert.deepEqual(RT.parse('').items, []);
  assert.deepEqual(RT.parse(null).items, []);
});

test('parse: malformed times are reported per line (1-based, counting blank lines) and never guessed', () => {
  const r = RT.parse('Good, 10:00\n\nBad seconds, 5:75\nWords, abc\nNegative, -5\nZero, 0\nToo long, 99999:00\nSmith, John');
  assert.deepEqual(r.items.map((i) => i.name), ['Good']);
  assert.deepEqual(r.errors.map((e) => e.line), [3, 4, 5, 6, 7, 8]);
  assert.match(r.errors[0].message, /5:75/);
  assert.match(r.errors[5].message, /John/);
});

test('parse: a trailing comma with no time keeps the default duration (as before); empty name is allowed', () => {
  const r = RT.parse('Placeholder,\n, 5:00');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.items, [{ name: 'Placeholder', durationMs: RT.DEFAULT_MS }, item('', 5)]);
});

test('parse: duplicate names and times are kept exactly as given', () => {
  const r = RT.parse('Break, 10:00\nBreak, 10:00\nSame time, 10:00');
  assert.equal(r.items.length, 3);
  assert.deepEqual(r.items.map((i) => i.durationMs), [10 * MIN, 10 * MIN, 10 * MIN]);
});

test('parse: over-long names are shortened with a warning, not an error', () => {
  const r = RT.parse(`${'x'.repeat(150)}, 1:00`);
  assert.equal(r.errors.length, 0);
  assert.equal(r.items[0].name.length, RT.MAX_NAME);
  assert.equal(r.warnings.length, 1);
});

test('round trip: copy -> rearrange externally -> Replace -> exact pasted order -> copy again', () => {
  const original = [item('Welcome', 5), item('Opening Remarks', 15), item('Session One', 40), item('Break', 10), item('Q&A, part 2', 20, 15)];
  const copied = RT.format(original);
  // Rearranged in Notepad: reversed, with a blank line, padding, CRLF and no final newline
  const lines = copied.split('\n');
  const revised = [lines[3], '', `   ${lines[4]}  `, lines[0], lines[2], lines[1]].join('\r\n');
  const plan = RT.planImport(original, revised, 'replace');
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.items.map((i) => i.name), ['Break', 'Q&A, part 2', 'Welcome', 'Session One', 'Opening Remarks']);
  assert.equal(RT.format(plan.items), [lines[3], lines[4], lines[0], lines[2], lines[1]].join('\n'));
  // and it survives a second lap unchanged
  assert.deepEqual(RT.parse(RT.format(plan.items)).items, plan.items);
});

test('round trip: every field of an item survives (name incl. commas, sub-minute durations, 100+ minute durations)', () => {
  const items = [item('A, B, and C', 0, 45), item('Long', 125, 5), item('', 1), item('ünïcödé ✓', 3)];
  assert.deepEqual(RT.parse(RT.format(items)).items, items);
});

test('Append keeps the existing rundown and adds after it (order preserved)', () => {
  const existing = [item('One', 1), item('Two', 2)];
  const plan = RT.planImport(existing, 'Three, 3:00\nFour, 4:00', 'append');
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.items.map((i) => i.name), ['One', 'Two', 'Three', 'Four']);
  assert.equal(plan.added, 2); assert.equal(plan.removed, 0);
  assert.equal(existing.length, 2, 'input array is not mutated');
  // empty append is a no-op, not an error (existing behaviour)
  const empty = RT.planImport(existing, '  \n ', 'append');
  assert.equal(empty.ok, true); assert.equal(empty.added, 0);
});

test('Replace swaps the whole rundown and reports what it removes', () => {
  const existing = [item('One', 1), item('Two', 2), item('Three', 3)];
  const plan = RT.planImport(existing, 'X, 9:00', 'replace');
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.items, [item('X', 9)]);
  assert.equal(plan.removed, 3); assert.equal(plan.added, 1);
});

test('invalid Replace leaves the existing rundown untouched: not-ok plan, nothing to apply', () => {
  const existing = [item('One', 1), item('Two', 2)];
  const snapshot = JSON.stringify(existing);
  const bad = RT.planImport(existing, 'Good, 5:00\nBad, 5:99\nAlso good', 'replace');
  assert.equal(bad.ok, false);
  assert.equal(bad.items, undefined, 'a failed plan carries no items to apply');
  assert.deepEqual(bad.errors.map((e) => e.line), [2]);
  assert.equal(JSON.stringify(existing), snapshot);
  // one bad line poisons the whole paste - no partial replace
  assert.equal(RT.planImport(existing, 'A, 1:00\nB, x', 'replace').ok, false);
});

test('Replace with empty / whitespace-only input is refused (cannot wipe the rundown)', () => {
  const existing = [item('One', 1)];
  for (const text of ['', '   ', '\n\n \r\n']) {
    const plan = RT.planImport(existing, text, 'replace');
    assert.equal(plan.ok, false, JSON.stringify(text));
    assert.match(plan.errors[0].message, /refusing/);
  }
});

test('Append with a bad line is also refused as a whole (no half-appended paste)', () => {
  const plan = RT.planImport([item('One', 1)], 'Fine, 2:00\nBroken, ??', 'append');
  assert.equal(plan.ok, false);
});

// ---------------------------------------------------------------- Add insertion point
test('insertionIndex: below the FIRST item', () => {
  assert.equal(RT.insertionIndex(0, 5), 1);
});

test('insertionIndex: below a MIDDLE item', () => {
  assert.equal(RT.insertionIndex(2, 5), 3);
  assert.equal(RT.insertionIndex(1, 5), 2);
});

test('insertionIndex: below the LAST item (equivalent to append, reached via selection rather than fallback)', () => {
  assert.equal(RT.insertionIndex(4, 5), 5);
});

test('insertionIndex: no active/selected item (-1) falls back to append at the end', () => {
  assert.equal(RT.insertionIndex(-1, 5), 5);
  assert.equal(RT.insertionIndex(-1, 0), 0);
});

test('insertionIndex: a stale/out-of-range/invalid active index also falls back to append, not a guess', () => {
  for (const bad of [5, 6, 100, NaN, undefined, null, 1.5, '2']) {
    assert.equal(RT.insertionIndex(bad, 5), 5, String(bad));
  }
});

test('Add, simulated end to end: existing lines from the insertion point onward move down by one, everything else is untouched', () => {
  const items = ['A', 'B', 'C', 'D', 'E'].map((n) => item(n, 1));
  const insertAt = RT.insertionIndex(1, items.length); // "B" (index 1) is active -> new line becomes line 3
  const next = items.slice();
  next.splice(insertAt, 0, { name: '', durationMs: RT.DEFAULT_MS });
  assert.deepEqual(next.map((i) => i.name), ['A', 'B', '', 'C', 'D', 'E']);
  assert.equal(next[insertAt].name, '', 'the new blank line lands exactly below the active one');
  assert.deepEqual(next.slice(0, insertAt), items.slice(0, insertAt), 'lines before the active one are untouched');
  assert.deepEqual(next.slice(insertAt + 1).map((i) => i.name), items.slice(insertAt).map((i) => i.name), 'the active line onward shifted down by one, order preserved');
});

test('Add, simulated end to end: nothing active/selected still appends at the end (existing fallback)', () => {
  const items = ['A', 'B', 'C'].map((n) => item(n, 1));
  const insertAt = RT.insertionIndex(-1, items.length);
  const next = items.slice();
  next.splice(insertAt, 0, { name: '', durationMs: RT.DEFAULT_MS });
  assert.deepEqual(next.map((i) => i.name), ['A', 'B', 'C', '']);
});

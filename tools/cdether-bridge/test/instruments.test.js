'use strict';

// Narrow tests for the P1.1 investigation instruments. These require the tool
// modules, which must NOT run their main() on require (require.main guard).

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRawFrame } = require('../tools/send-frame');
const { changedBytes, decode, parseArgs } = require('../tools/sniff');

const bytes = (b) => [...b];

// --- send-frame.js --raw parsing ---

test('parseRawFrame: space-separated hex', () => {
  assert.deepEqual(bytes(parseRawFrame('10 32 05')), [0x10, 0x32, 0x05]);
});

test('parseRawFrame: 0x prefixes', () => {
  assert.deepEqual(bytes(parseRawFrame('0x10 0X32 0x05')), [0x10, 0x32, 0x05]);
});

test('parseRawFrame: comma-separated and stray whitespace', () => {
  assert.deepEqual(bytes(parseRawFrame('  10, 32 ,05 ')), [0x10, 0x32, 0x05]);
});

test('parseRawFrame: single-digit nibbles', () => {
  assert.deepEqual(bytes(parseRawFrame('1 2 3')), [1, 2, 3]);
});

test('parseRawFrame: mixed case and full range', () => {
  assert.deepEqual(bytes(parseRawFrame('aB Cd fF')), [0xab, 0xcd, 0xff]);
  assert.deepEqual(bytes(parseRawFrame('00 00 00')), [0, 0, 0]);
});

test('parseRawFrame: always returns exactly 3 bytes', () => {
  assert.equal(parseRawFrame('10 32 05').length, 3);
});

test('parseRawFrame rejects the wrong number of tokens', () => {
  assert.throws(() => parseRawFrame('10 32'), /exactly three/);
  assert.throws(() => parseRawFrame('10 32 05 01'), /exactly three/);
  assert.throws(() => parseRawFrame(''), /exactly three/);
  assert.throws(() => parseRawFrame('   '), /exactly three/);
  assert.throws(() => parseRawFrame(null), /exactly three/);
});

test('parseRawFrame rejects non-hex / out-of-range tokens', () => {
  assert.throws(() => parseRawFrame('10 3g 05'), /not a hex byte/);
  assert.throws(() => parseRawFrame('10 32 1ff'), /not a hex byte/); // 3 hex digits > 0xff
  assert.throws(() => parseRawFrame('10 32 256'), /not a hex byte/);
  assert.throws(() => parseRawFrame('-1 32 05'), /not a hex byte/);
});

test('requiring send-frame.js does not run main / send anything', () => {
  // Reaching here at all means require() did not invoke main() (which needs a
  // destination and would throw/exit). The export is enough of an assertion.
  assert.equal(typeof parseRawFrame, 'function');
});

// --- sniff.js helpers ---

test('sniff changedBytes', () => {
  assert.deepEqual(changedBytes(null, '10 32 05'), []);
  assert.deepEqual(changedBytes('10 32 05', '10 32 05'), []);
  assert.deepEqual(changedBytes('10 32 05', '10 32 06'), ['b3']);
  assert.deepEqual(changedBytes('10 32 05', '11 32 07'), ['b1', 'b3']);
});

test('sniff decode: standard, unknown state, and non-standard length', () => {
  assert.match(decode(Buffer.from([0x21, 0x43, 0x01])), /12:34 green/);
  assert.match(decode(Buffer.from([0x21, 0x43, 0x05])), /0x05/);
  assert.match(decode(Buffer.from([1, 2])), /non-standard/);
});

test('sniff parseArgs', () => {
  assert.deepEqual(parseArgs([]), { diff: false, port: 36700, bind: '0.0.0.0', help: false });
  assert.equal(parseArgs(['--diff']).diff, true);
  assert.equal(parseArgs(['--port', '40000']).port, 40000);
  assert.equal(parseArgs(['--bind', '192.168.8.238']).bind, '192.168.8.238');
});

test('requiring sniff.js does not bind a socket / run main', () => {
  assert.equal(typeof changedBytes, 'function');
});

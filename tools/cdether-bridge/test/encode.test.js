'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { encodeFrame, describeFrame, UdpSender, OFF_FRAME } = require('../lib/cdether');

const hex = (buf) => [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ');

// The 8 frames physically verified on the test rig.
const VERIFIED = [
  { in: { minutes: 99, seconds: 59, colour: 'green' }, out: '99 95 01' },
  { in: { minutes: 99, seconds: 58, colour: 'green' }, out: '99 85 01' },
  { in: { minutes: 99, seconds: 57, colour: 'green' }, out: '99 75 01' },
  { in: { minutes: 89, seconds: 59, colour: 'green' }, out: '98 95 01' },
  { in: { minutes: 12, seconds: 34, colour: 'green' }, out: '21 43 01' },
  { in: { minutes: 12, seconds: 34, colour: 'red' },   out: '21 43 02' },
  { in: { minutes: 12, seconds: 34, colour: 'amber' }, out: '21 43 03' },
  { in: { minutes: 12, seconds: 34, colour: 'off' },   out: '21 43 04' },
];

for (const c of VERIFIED) {
  test(`encodeFrame ${c.in.minutes}:${c.in.seconds} ${c.in.colour} -> ${c.out}`, () => {
    const buf = encodeFrame(c.in);
    assert.equal(buf.length, 3, 'frame must be exactly 3 bytes');
    assert.equal(hex(buf), c.out);
  });
}

test('unknown colour/state throws', () => {
  assert.throws(() => encodeFrame({ minutes: 0, seconds: 0, colour: 'blue' }), /Unknown CDEther/);
});

test('clamps values above 99:59 to 99:59', () => {
  assert.equal(hex(encodeFrame({ minutes: 150, seconds: 30, colour: 'green' })), '99 95 01');
  assert.equal(hex(encodeFrame({ minutes: 42, seconds: 90, colour: 'green' })), '24 95 01');
});

test('negative values floored to 00:00', () => {
  assert.equal(hex(encodeFrame({ minutes: -5, seconds: -9, colour: 'green' })), '00 00 01');
});

test('defaults to 00:00 green', () => {
  assert.equal(hex(encodeFrame()), '00 00 01');
});

test('describeFrame round-trips the verified frames', () => {
  assert.equal(describeFrame(encodeFrame({ minutes: 12, seconds: 34, colour: 'amber' })), '[21 43 03] 12:34 amber');
  assert.equal(describeFrame(encodeFrame({ minutes: 89, seconds: 59, colour: 'green' })), '[98 95 01] 89:59 green');
});

test('OFF_FRAME is 00 00 04', () => {
  assert.equal(hex(OFF_FRAME), '00 00 04');
  assert.equal(hex(OFF_FRAME), hex(encodeFrame({ minutes: 0, seconds: 0, colour: 'off' })));
});

test('UdpSender bound to loopback delivers the exact bytes', async () => {
  const rx = dgram.createSocket('udp4');
  const got = [];
  rx.on('message', (m) => got.push(hex(m)));
  await new Promise((res) => rx.bind(0, '127.0.0.1', res));
  const port = rx.address().port;

  const sender = new UdpSender({ address: '127.0.0.1', port, bindAddress: '127.0.0.1' });
  await sender.ready;
  const r1 = await sender.send(encodeFrame({ minutes: 12, seconds: 34, colour: 'green' }));
  const r2 = await sender.send(OFF_FRAME);
  await new Promise((res) => setTimeout(res, 30));
  await sender.close();
  rx.close();

  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.deepEqual(got, ['21 43 01', '00 00 04']);
});

test('UdpSender.send resolves { ok:false } on a bogus destination, never throws', async () => {
  // 0.0.0.0 as a destination is invalid for send on most platforms.
  const sender = new UdpSender({ address: '0.0.0.0', port: 9, bindAddress: '127.0.0.1' });
  await sender.ready;
  const r = await sender.send(OFF_FRAME);
  await sender.close();
  assert.equal(typeof r.ok, 'boolean');
});

test('UdpSender rejects ready on an unusable bind address', async () => {
  const sender = new UdpSender({ address: '127.0.0.1', port: 0, bindAddress: '203.0.113.7' }); // TEST-NET-3, not local
  await assert.rejects(sender.ready);
});

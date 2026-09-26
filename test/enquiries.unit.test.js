'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateEnquiry, buildEmail, sendNotification } = require('../enquiries');

test('valid enquiry is trimmed, email lowercased, unknown interests dropped', () => {
  const r = validateEnquiry({ name: '  Sam ', email: ' Sam@Example.COM ', company: ' Acme ', interests: ['trial', 'bogus', 'trial', 5], message: ' hi ' });
  assert.deepEqual(r, { ok: true, enquiry: { name: 'Sam', email: 'sam@example.com', company: 'Acme', interests: ['trial'], message: 'hi' } });
});

test('missing name / bad email / over-long fields are rejected', () => {
  assert.equal(validateEnquiry({ email: 'a@b.co' }).ok, false);
  assert.equal(validateEnquiry({ name: 'A', email: 'not-an-email' }).ok, false);
  assert.equal(validateEnquiry({ name: 'A', email: 'a@b.co', message: 'x'.repeat(4001) }).ok, false);
  assert.equal(validateEnquiry(null).ok, false);
});

test('a filled honeypot is flagged as spam, not an error', () => {
  assert.deepEqual(validateEnquiry({ name: 'Bot', email: 'b@b.co', website: 'http://spam' }), { ok: true, spam: true });
});

test('email text carries the details and readable interests', () => {
  const { subject, text } = buildEmail({ name: 'Sam', email: 'sam@x.co', company: 'Acme', interests: ['local', 'call'], message: '3 rooms' });
  assert.match(subject, /Sam \(Acme\)/);
  assert.match(text, /Local show server, A quick call/);
  assert.match(text, /3 rooms/);
});

test('sendNotification: not configured without RESEND_API_KEY, never calls fetch', async () => {
  let called = false;
  const r = await sendNotification({ name: 'A', email: 'a@b.co', interests: [] }, { env: {}, fetchImpl: () => { called = true; } });
  assert.deepEqual(r, { sent: false, reason: 'not_configured' });
  assert.equal(called, false);
});

test('sendNotification: posts to Resend with defaults and reply_to the enquirer', async () => {
  let req;
  const r = await sendNotification({ name: 'A', email: 'a@b.co', interests: [] }, {
    env: { RESEND_API_KEY: 'k' },
    fetchImpl: async (url, opts) => { req = { url, opts }; return { ok: true }; }
  });
  assert.deepEqual(r, { sent: true });
  assert.equal(req.url, 'https://api.resend.com/emails');
  assert.equal(req.opts.headers.Authorization, 'Bearer k');
  const body = JSON.parse(req.opts.body);
  assert.deepEqual(body.to, ['foxytimer@bizshows.co.uk']);
  assert.equal(body.reply_to, 'a@b.co');
});

test('sendNotification: HTTP error and network failure are reported, not thrown', async () => {
  const env = { RESEND_API_KEY: 'k' };
  const enquiry = { name: 'A', email: 'a@b.co', interests: [] };
  assert.deepEqual(await sendNotification(enquiry, { env, fetchImpl: async () => ({ ok: false, status: 403 }) }), { sent: false, reason: 'http_403' });
  assert.deepEqual(await sendNotification(enquiry, { env, fetchImpl: async () => { throw new Error('offline'); } }), { sent: false, reason: 'offline' });
});

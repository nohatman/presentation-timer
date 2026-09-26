'use strict';

// Landing-page contact / trial-request form: validation and the optional email
// notification. Storage lives in db.js (enquiries table); the route is in
// server.js. Every enquiry is saved whether or not an email goes out - the
// admin Clients page lists them - so a missing or failing email setup never
// loses one.
//
// Email goes through Resend's HTTP API rather than SMTP because Railway blocks
// outbound SMTP on non-Pro plans. Configure with env vars:
//   RESEND_API_KEY      required to send at all (unset = store only)
//   CONTACT_EMAIL_TO    default foxytimer@bizshows.co.uk
//   CONTACT_EMAIL_FROM  default "Foxy Timer <foxytimer@bizshowsapp.co.uk>" -
//                       must be on a domain verified in Resend

const INTERESTS = {
  trial: 'A free trial',
  local: 'Local show server',
  companion: 'Companion / Stream Deck',
  call: 'A quick call'
};

const LIMITS = { name: 100, email: 200, company: 150, message: 4000 };

const DEFAULT_TO = 'foxytimer@bizshows.co.uk';
const DEFAULT_FROM = 'Foxy Timer <foxytimer@bizshowsapp.co.uk>';

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// -> { ok: true, enquiry } | { ok: false, error } | { ok: true, spam: true }
// A filled-in honeypot field ("website") is reported as spam so the route can
// answer with a normal-looking success without storing anything.
function validateEnquiry(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (clean(b.website)) return { ok: true, spam: true };

  const enquiry = {
    name: clean(b.name),
    email: clean(b.email).toLowerCase(),
    company: clean(b.company),
    message: clean(b.message),
    interests: Array.isArray(b.interests)
      ? [...new Set(b.interests.filter((i) => typeof i === 'string' && Object.hasOwn(INTERESTS, i)))]
      : []
  };

  if (!enquiry.name) return { ok: false, error: 'Please add your name.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(enquiry.email)) return { ok: false, error: 'Please add a valid email address.' };
  for (const [field, max] of Object.entries(LIMITS)) {
    if (enquiry[field].length > max) return { ok: false, error: `That ${field} is too long (max ${max} characters).` };
  }
  return { ok: true, enquiry };
}

function buildEmail(enquiry) {
  const interests = enquiry.interests.map((i) => INTERESTS[i]).join(', ') || '(none ticked)';
  const subject = `Foxy Timer enquiry: ${enquiry.name}${enquiry.company ? ` (${enquiry.company})` : ''}`;
  const text = [
    `Name:       ${enquiry.name}`,
    `Email:      ${enquiry.email}`,
    `Company:    ${enquiry.company || '-'}`,
    `Interested: ${interests}`,
    '',
    'What are you running?',
    enquiry.message || '-',
    '',
    'Reply to this email to answer them directly. All enquiries are also listed on the admin Clients page.'
  ].join('\n');
  return { subject, text };
}

// -> { sent: true } | { sent: false, reason }. Never throws: the enquiry is
// already stored, so a failed notification is logged, not surfaced to the
// visitor.
async function sendNotification(enquiry, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) return { sent: false, reason: 'not_configured' };
  const { subject, text } = buildEmail(enquiry);
  try {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.CONTACT_EMAIL_FROM || DEFAULT_FROM,
        to: [env.CONTACT_EMAIL_TO || DEFAULT_TO],
        reply_to: enquiry.email,
        subject,
        text
      })
    });
    if (!res.ok) return { sent: false, reason: `http_${res.status}` };
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err && err.message ? err.message : 'network_error' };
  }
}

module.exports = { INTERESTS, LIMITS, validateEnquiry, buildEmail, sendNotification };

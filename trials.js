'use strict';

// Foxy Timer for Windows trial licences.
//
// Foxy Timer Online issues them: the Windows app asks once, on first launch,
// with a machine id; Online signs { machine, expiresAt } with an Ed25519
// private key (FOXY_LICENCE_PRIVATE_KEY, Railway only). The app checks the
// signature offline with the public key below, so after that first launch a
// show laptop never needs the internet. A licence is just
// base64url(JSON payload) + '.' + base64url(signature).
//
// Trial length is an admin setting (meta 'windows_trial_days') and only
// applies to trials that start after it changes. One trial per machine:
// asking again returns the stored expiry, so reinstalling doesn't reset it,
// and an admin extending a trial reaches the app the next time it's online.

const crypto = require('crypto');

// Matching private key lives only in Railway's FOXY_LICENCE_PRIVATE_KEY.
// Regenerate both with scripts/make-licence-keys.js (old licences then stop
// verifying, so only do that if the private key leaks).
const LICENCE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAqe9I2s6vc75sk4vOvDO8jYaJaHuvWGaUzTqFDjIi6iI=
-----END PUBLIC KEY-----`;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TRIAL_DAYS = 14;
const MAX_TRIAL_DAYS = 365;
const MACHINE_ID_RE = /^[a-f0-9]{32,128}$/i;

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

// Railway env vars are single-line, so accept a PEM with literal "\n"s.
function privateKeyFromEnv() {
  const raw = process.env.FOXY_LICENCE_PRIVATE_KEY;
  if (!raw) return null;
  try {
    return crypto.createPrivateKey(raw.replace(/\\n/g, '\n'));
  } catch {
    return null;
  }
}

function isConfigured() {
  return privateKeyFromEnv() !== null;
}

function signLicence({ id, machine, issuedAt, expiresAt }, privateKey = privateKeyFromEnv()) {
  if (!privateKey) throw new Error('FOXY_LICENCE_PRIVATE_KEY is not set');
  const payload = Buffer.from(JSON.stringify({ v: 1, kind: 'trial', id, machine, issuedAt, expiresAt }));
  const sig = crypto.sign(null, payload, privateKey);
  return `${b64url(payload)}.${b64url(sig)}`;
}

// Returns the payload if the signature is good and it's for this machine,
// otherwise null. Says nothing about expiry - see licenceStatus().
function verifyLicence(licence, machineId, publicKey = LICENCE_PUBLIC_KEY) {
  if (typeof licence !== 'string') return null;
  const parts = licence.split('.');
  if (parts.length !== 2) return null;
  try {
    const payload = Buffer.from(parts[0], 'base64url');
    const sig = Buffer.from(parts[1], 'base64url');
    if (!crypto.verify(null, payload, publicKey, sig)) return null;
    const data = JSON.parse(payload.toString('utf8'));
    if (data.v !== 1 || typeof data.expiresAt !== 'number') return null;
    if (machineId && data.machine !== machineId) return null;
    return data;
  } catch {
    return null;
  }
}

// 'active' | 'expired' | 'invalid', plus days left (rounded up) when active.
function licenceStatus(licence, machineId, now = Date.now(), publicKey = LICENCE_PUBLIC_KEY) {
  const data = verifyLicence(licence, machineId, publicKey);
  if (!data) return { status: 'invalid' };
  if (now >= data.expiresAt) return { status: 'expired', expiresAt: data.expiresAt };
  // An hour's leeway so a laptop clock a little behind Online's doesn't turn a
  // fresh 14-day trial into "15 days left"; never shows 0 while still active.
  const daysLeft = Math.max(1, Math.ceil((data.expiresAt - now - 60 * 60 * 1000) / DAY_MS));
  return { status: 'active', expiresAt: data.expiresAt, daysLeft };
}

function parseTrialDays(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= MAX_TRIAL_DAYS ? n : null;
}

function isValidMachineId(value) {
  return typeof value === 'string' && MACHINE_ID_RE.test(value);
}

// Blank clears it; otherwise must be an https link.
function parseDownloadUrl(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

module.exports = {
  LICENCE_PUBLIC_KEY,
  DAY_MS,
  DEFAULT_TRIAL_DAYS,
  MAX_TRIAL_DAYS,
  isConfigured,
  privateKeyFromEnv,
  signLicence,
  verifyLicence,
  licenceStatus,
  parseTrialDays,
  isValidMachineId,
  parseDownloadUrl
};

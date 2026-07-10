#!/usr/bin/env node
// Resets a user's password to a new generated temporary one - use this if a
// user forgot their password (no self-service reset exists yet - no email
// dependency at this stage) or if credentials need to be revoked.
//
// This re-flags must_change_password AND invalidates every existing session
// for that user, on every device - a reset means the account's prior state is
// no longer trusted, not just "give me a new password to try alongside the old one."
//
// Usage: node scripts/reset-user-password.js "email@client.com"

const db = require('../db');

const email = process.argv.slice(2).join(' ').trim();

if (!email) {
  console.error('Usage: node scripts/reset-user-password.js "email@client.com"');
  process.exit(1);
}

const result = db.resetUserPassword(email);

if (!result) {
  console.error(`❌ No user with email "${email}" found.`);
  process.exit(1);
}

console.log(`\n✅ Reset password for "${result.email}" - all existing sessions for this user have been invalidated.\n`);
console.log(`🔑 New temporary password (shown once):\n`);
console.log(`   ${result.tempPassword}\n`);
console.log(`They will be required to choose a new password on next login at /login.\n`);

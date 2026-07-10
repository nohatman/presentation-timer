#!/usr/bin/env node
// Renames an existing user's login email in place - same user id, password,
// must_change_password state, and client association (so platform-admin
// status, derived from that client link, is untouched too). Does not touch
// client API keys or room tokens. Invalidates that user's existing sessions,
// so they must log in again with the new address.
//
// For a LOCAL database only. If the account you need to rename lives on
// Railway's production volume, this script cannot reach it - see
// RENAME_USER_EMAIL_FROM / RENAME_USER_EMAIL_TO in db.js instead (same
// boot-time env-var pattern as BOOTSTRAP_ADMIN_USER_EMAIL).
//
// Usage: node scripts/change-user-email.js "current-email@example.com" "new-email@example.com"

const db = require('../db');

const [currentEmail, newEmail] = process.argv.slice(2);

if (!currentEmail || !newEmail) {
  console.error('Usage: node scripts/change-user-email.js "current-email@example.com" "new-email@example.com"');
  process.exit(1);
}

const result = db.changeUserEmail(currentEmail, newEmail);

if (!result.ok) {
  console.error(`❌ ${result.error}`);
  process.exit(1);
}

console.log(`\n✅ Renamed user id=${result.id}: "${result.oldEmail}" → "${result.newEmail}"`);
console.log(`   All existing sessions for this user were invalidated - they must log in again with the new email.\n`);

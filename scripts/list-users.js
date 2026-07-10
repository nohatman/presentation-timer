#!/usr/bin/env node
// Lists every human dashboard login, with the client they belong to. Never
// prints password hashes or anything password-related - read-only, safe to
// run any time. Use create-user.js / reset-user-password.js to make changes.
//
// Usage: node scripts/list-users.js

const db = require('../db');

const users = db.listUsers();

if (users.length === 0) {
  console.log('\nNo users yet. Use scripts/create-user.js to provision one.\n');
  process.exit(0);
}

console.log('');
for (const u of users) {
  const adminTag = u.is_platform_admin ? ' [PLATFORM ADMIN]' : '';
  const changeTag = u.must_change_password ? ' (must change password)' : '';
  const created = new Date(u.created_at).toISOString().slice(0, 10);
  console.log(`• ${u.email}${adminTag}  -  client "${u.client_name}"  (status=${u.status}, created=${created})${changeTag}`);
}
console.log('');

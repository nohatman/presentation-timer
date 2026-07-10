#!/usr/bin/env node
// Provisions a human dashboard login for an existing client, with a generated
// temporary password. The user must change it on first login (must_change_password).
//
// Usage: node scripts/create-user.js "email@client.com" "Client Name"

const db = require('../db');

const args = process.argv.slice(2);
const email = args[0];
const clientName = args.slice(1).join(' ').trim();

if (!email || !clientName) {
  console.error('Usage: node scripts/create-user.js "email@client.com" "Client Name"');
  process.exit(1);
}

if (db.getUserByEmail(email)) {
  console.error(`❌ A user with email "${email}" already exists. Use scripts/reset-user-password.js to reissue credentials.`);
  process.exit(1);
}

const client = db.getClientByName(clientName);
if (!client) {
  console.error(`❌ No client named "${clientName}" found. Create it first with scripts/create-client.js.`);
  process.exit(1);
}

const tempPassword = db.generateTempPassword();
const user = db.createUser(email, tempPassword, client.id, { mustChangePassword: true });

console.log(`\n✅ Created login for "${user.email}" (user id=${user.id}, client "${client.name}")\n`);
console.log(`🔑 Temporary password (shown once - hand this to the client via a secure channel):\n`);
console.log(`   ${tempPassword}\n`);
console.log(`They will be required to choose a new password on first login at /login.\n`);

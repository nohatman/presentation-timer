#!/usr/bin/env node
// Provisions a new client and prints its API key ONCE.
//
// Usage: node scripts/create-client.js "Client Name"
//
// The key is stored only as a hash - if you lose the printed value, there is no
// way to recover it. Use scripts/rotate-client-key.js to issue a new one instead.

const db = require('../db');

const name = process.argv.slice(2).join(' ').trim();

if (!name) {
  console.error('Usage: node scripts/create-client.js "Client Name"');
  process.exit(1);
}

if (db.getClientByName(name)) {
  console.error(`❌ A client named "${name}" already exists. Use scripts/rotate-client-key.js to reissue its key.`);
  process.exit(1);
}

const client = db.createClient(name);

console.log(`\n✅ Created client "${client.name}" (id=${client.id})\n`);
console.log(`🔑 API key (shown once - store it now, e.g. in a password manager):\n`);
console.log(`   ${client.apiKey}\n`);
console.log(`Use it as: Authorization: Bearer ${client.apiKey}\n`);

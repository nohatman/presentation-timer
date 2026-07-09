#!/usr/bin/env node
// Issues a brand new API key for an existing client, invalidating the old one
// immediately. Use this if a key leaks, or if the one-time printed value from
// scripts/create-client.js (or the automatic Legacy client key) was lost.
//
// Usage: node scripts/rotate-client-key.js "Client Name"

const db = require('../db');

const name = process.argv.slice(2).join(' ').trim();

if (!name) {
  console.error('Usage: node scripts/rotate-client-key.js "Client Name"');
  process.exit(1);
}

const result = db.rotateClientApiKey(name);

if (!result) {
  console.error(`❌ No client named "${name}" found.`);
  process.exit(1);
}

console.log(`\n✅ Rotated API key for client "${result.name}" (id=${result.id})\n`);
console.log(`🔑 New API key (shown once - the old key stopped working immediately):\n`);
console.log(`   ${result.apiKey}\n`);
console.log(`Use it as: Authorization: Bearer ${result.apiKey}\n`);

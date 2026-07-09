#!/usr/bin/env node
// Provisions a PLATFORM ADMIN - BizShows-only, cross-client visibility and control.
// This is by far the most powerful credential in the system: it can see and act on
// every client's rooms, not just one. Prefer a normal client key (see
// scripts/create-client.js) for day-to-day management of your own rooms; reserve
// this one for actual cross-client support situations.
//
// Usage: node scripts/create-platform-admin.js "Name"

const db = require('../db');

const name = process.argv.slice(2).join(' ').trim();

if (!name) {
  console.error('Usage: node scripts/create-platform-admin.js "Name"');
  process.exit(1);
}

if (db.getClientByName(name)) {
  console.error(`❌ A client named "${name}" already exists. Use scripts/rotate-client-key.js to reissue its key.`);
  process.exit(1);
}

const admin = db.createPlatformAdmin(name);

console.log(`\n⚠️  Created PLATFORM ADMIN "${admin.name}" (id=${admin.id}) - this key can see and control EVERY client's rooms.\n`);
console.log(`🔑 API key (shown once - store it now, e.g. in a password manager):\n`);
console.log(`   ${admin.apiKey}\n`);
console.log(`Use it as: Authorization: Bearer ${admin.apiKey}\n`);

#!/usr/bin/env node
// Lists every client (and platform admin) on this server, with room counts.
// Read-only - use create-client.js / create-platform-admin.js / rotate-client-key.js
// to make changes.
//
// Usage: node scripts/list-clients.js

const db = require('../db');

const clients = db.listClients();

if (clients.length === 0) {
  console.log('\nNo clients yet. Use scripts/create-client.js to provision one.\n');
  process.exit(0);
}

console.log('');
for (const c of clients) {
  const tag = c.is_platform_admin ? ' [PLATFORM ADMIN]' : '';
  const created = new Date(c.created_at).toISOString().slice(0, 10);
  console.log(`• ${c.name}${tag}  (id=${c.id}, status=${c.status}, rooms=${c.room_count}, created=${created})`);
}
console.log('');

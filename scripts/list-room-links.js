#!/usr/bin/env node
// Prints control/display links for a client's rooms. This is the quick,
// dashboard-independent way to recover links after the Phase 2 cutover (old
// ?room=slug links no longer work), or after a leak.
//
// Usage:
//   node scripts/list-room-links.js "Client Name"
//   node scripts/list-room-links.js "Client Name" --regenerate room-slug
//
// Set PUBLIC_URL to your real deployment URL (e.g. https://yourapp.up.railway.app)
// before running against production - it defaults to http://localhost:3000.

const db = require('../db');
const { buildRoomLinks } = require('../urls');

const args = process.argv.slice(2);
const regenIndex = args.indexOf('--regenerate');
const regenerateSlug = regenIndex !== -1 ? args[regenIndex + 1] : null;
const name = (regenIndex !== -1 ? args.slice(0, regenIndex) : args).join(' ').trim();

if (!name) {
  console.error('Usage: node scripts/list-room-links.js "Client Name" [--regenerate room-slug]');
  process.exit(1);
}

const client = db.getClientByName(name);
if (!client) {
  console.error(`❌ No client named "${name}" found.`);
  process.exit(1);
}

const baseUrl = process.env.PUBLIC_URL || 'http://localhost:3000';
if (!process.env.PUBLIC_URL) {
  console.warn(`⚠️  PUBLIC_URL not set - printing localhost links. Set it to your real deployment URL for production links.\n`);
}

if (regenerateSlug) {
  const updated = db.regenerateRoomTokens(client.id, regenerateSlug);
  if (!updated) {
    console.error(`❌ No room named "${regenerateSlug}" found for client "${name}".`);
    process.exit(1);
  }
  const links = buildRoomLinks(baseUrl, updated);
  console.log(`\n✅ Regenerated tokens for "${regenerateSlug}" - old links are now invalid.\n`);
  console.log(`Control: ${links.controlUrl}`);
  console.log(`Display: ${links.displayUrl}\n`);
  process.exit(0);
}

const rooms = db.getRoomsForClient(client.id);
if (rooms.length === 0) {
  console.log(`\nClient "${name}" has no rooms yet.\n`);
  process.exit(0);
}

console.log(`\nRooms for client "${name}":\n`);
for (const room of rooms) {
  const links = buildRoomLinks(baseUrl, room);
  console.log(`• ${room.slug}`);
  console.log(`  Control: ${links.controlUrl}`);
  console.log(`  Display: ${links.displayUrl}\n`);
}

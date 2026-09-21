'use strict';

// Read-only room lookup so the launcher can open the right Control/Display page
// (those URLs carry per-room secret tokens). Deliberately does NOT require
// ../../db.js: that module migrates the schema and imports legacy data on load,
// which a launcher must never do. Same DB path rule as db.js.

const fs = require('fs');
const path = require('path');
const { buildRoomLinks } = require('../../../urls');

function databasePath(rootDir) {
  return process.env.DATABASE_PATH || path.join(rootDir, 'data', 'presentation-timer.sqlite');
}

// -> { rooms: [{ id, slug, control_token, display_token }], error }
function readRooms(rootDir) {
  const file = databasePath(rootDir);
  if (!fs.existsSync(file)) return { rooms: [], error: `No database yet (${file}). Create a room first.` };
  try {
    const Database = require('better-sqlite3');
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      const rooms = db.prepare('SELECT id, slug, control_token, display_token FROM rooms WHERE hidden = 0 ORDER BY id').all();
      return { rooms, error: null };
    } finally { db.close(); }
  } catch (e) {
    return { rooms: [], error: `Could not read rooms: ${e.message}` };
  }
}

// Which room does "open control" mean? Pure.
//   explicit slug wins; a single room is unambiguous; else the last-used one if it
//   still exists; else the caller must ask the operator (choices).
function pickRoom(rooms, { slug, lastSlug } = {}) {
  if (!rooms.length) return { room: null, choices: [] };
  if (slug) {
    const hit = rooms.find((r) => r.slug === slug);
    return hit ? { room: hit } : { room: null, choices: rooms, notFound: slug };
  }
  if (rooms.length === 1) return { room: rooms[0] };
  const last = lastSlug && rooms.find((r) => r.slug === lastSlug);
  return last ? { room: last, remembered: true, choices: rooms } : { room: null, choices: rooms };
}

function linksFor(room, baseUrl) { return buildRoomLinks(baseUrl, room); }

module.exports = { databasePath, readRooms, pickRoom, linksFor };

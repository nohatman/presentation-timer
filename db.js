// SQLite persistence layer - Clients / Events / Rooms
//
// Runtime room state still lives in server.js's in-memory Map, exactly as before.
// This module is only responsible for loading that Map at boot and saving it back
// on the existing debounced schedule - it is not the timing engine.
//
// Phase 1 scope: all rooms live under a single synthetic "Legacy" client/event.
// Multi-client/multi-event routing is Phase 2+.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATABASE_PATH = process.env.DATABASE_PATH
  || path.join(__dirname, 'data', 'presentation-timer.sqlite');

const LEGACY_ROOMS_JSON_PATH = process.env.LEGACY_ROOMS_JSON_PATH
  || path.join(__dirname, 'rooms.json');

fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });

const db = new Database(DATABASE_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    api_key_hash TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES clients(id),
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES events(id),
    slug TEXT NOT NULL,
    control_token TEXT NOT NULL UNIQUE,
    display_token TEXT NOT NULL UNIQUE,
    hidden INTEGER NOT NULL DEFAULT 0,
    state_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(event_id, slug)
  );

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

function generateToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function getMeta(key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setMeta(key, value) {
  db.prepare(`
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

// Idempotent: safe to call on every boot.
function getOrCreateLegacyEvent() {
  const now = Date.now();

  let client = db.prepare('SELECT * FROM clients WHERE name = ?').get('Legacy');
  if (!client) {
    const info = db.prepare(
      'INSERT INTO clients (name, status, created_at) VALUES (?, ?, ?)'
    ).run('Legacy', 'active', now);
    client = { id: info.lastInsertRowid };
    console.log(`📦 Created Legacy client (id=${client.id})`);
  }

  let event = db.prepare('SELECT * FROM events WHERE client_id = ? AND name = ?')
    .get(client.id, 'Legacy Rooms');
  if (!event) {
    const info = db.prepare(
      'INSERT INTO events (client_id, name, created_at) VALUES (?, ?, ?)'
    ).run(client.id, 'Legacy Rooms', now);
    event = { id: info.lastInsertRowid };
    console.log(`📦 Created Legacy Rooms event (id=${event.id})`);
  }

  return event.id;
}

const LEGACY_EVENT_ID = getOrCreateLegacyEvent();

// Runs at most once ever - guarded by a meta flag set after this check completes,
// whether or not a file was found. Existing rooms.json data does not need to be
// retained: if the file is missing, we warn once, start with an empty Legacy
// Client/Event, and move on without error. This never re-checks on later boots.
function importLegacyRoomsJsonIfNeeded() {
  if (getMeta('legacy_rooms_imported_at')) return;

  if (!fs.existsSync(LEGACY_ROOMS_JSON_PATH)) {
    console.warn(
      `⚠️  No legacy rooms.json found at ${LEGACY_ROOMS_JSON_PATH} - starting with an ` +
      `empty Legacy Client/Event and continuing normally.`
    );
    setMeta('legacy_rooms_imported_at', String(Date.now()));
    return;
  }

  try {
    const raw = fs.readFileSync(LEGACY_ROOMS_JSON_PATH, 'utf8');
    const data = JSON.parse(raw);
    const entries = Object.entries(data);
    const now = Date.now();

    const insert = db.prepare(`
      INSERT INTO rooms (event_id, slug, control_token, display_token, hidden, state_json, created_at, updated_at)
      VALUES (@event_id, @slug, @control_token, @display_token, 0, @state_json, @created_at, @updated_at)
    `);

    const importAll = db.transaction((rows) => {
      for (const [slug, state] of rows) {
        insert.run({
          event_id: LEGACY_EVENT_ID,
          slug,
          control_token: generateToken(),
          display_token: generateToken(),
          state_json: JSON.stringify(state),
          created_at: now,
          updated_at: now
        });
      }
    });

    importAll(entries);
    setMeta('legacy_rooms_imported_at', String(now));
    console.log(`✅ Imported ${entries.length} room(s) from ${LEGACY_ROOMS_JSON_PATH} into the Legacy event`);
  } catch (err) {
    console.error(`❌ Failed to import ${LEGACY_ROOMS_JSON_PATH}:`, err.message);
    console.error('   Legacy Client/Event exists but no rooms were imported. Fix the file and restart to retry.');
    // Deliberately not setting the meta flag - a corrected file can be retried on next boot.
  }
}

importLegacyRoomsJsonIfNeeded();

// Load every room's state_json into a Map keyed by slug, matching the shape
// server.js has always used internally (Map<roomId, timerState>).
function loadAllRoomStates() {
  const rows = db.prepare('SELECT slug, state_json FROM rooms').all();
  const result = new Map();
  for (const row of rows) {
    try {
      result.set(row.slug, JSON.parse(row.state_json));
    } catch (err) {
      console.error(`⚠️  Skipping room "${row.slug}" - corrupt state_json:`, err.message);
    }
  }
  return result;
}

// Upsert every room currently in the in-memory Map. New slugs get fresh tokens;
// existing rows keep their original tokens/created_at (ON CONFLICT only touches
// state_json/updated_at). All rooms land under the Legacy event in Phase 1.
function saveRoomStates(timerRooms) {
  const now = Date.now();

  const upsert = db.prepare(`
    INSERT INTO rooms (event_id, slug, control_token, display_token, hidden, state_json, created_at, updated_at)
    VALUES (@event_id, @slug, @control_token, @display_token, 0, @state_json, @created_at, @updated_at)
    ON CONFLICT(event_id, slug) DO UPDATE SET
      state_json = excluded.state_json,
      updated_at = excluded.updated_at
  `);

  const saveAll = db.transaction((entries) => {
    for (const [slug, state] of entries) {
      upsert.run({
        event_id: LEGACY_EVENT_ID,
        slug,
        control_token: generateToken(),
        display_token: generateToken(),
        state_json: JSON.stringify(state),
        created_at: now,
        updated_at: now
      });
    }
  });

  saveAll(Array.from(timerRooms.entries()));
}

function deleteRoom(slug) {
  db.prepare('DELETE FROM rooms WHERE event_id = ? AND slug = ?').run(LEGACY_EVENT_ID, slug);
}

module.exports = {
  DATABASE_PATH,
  LEGACY_ROOMS_JSON_PATH,
  loadAllRoomStates,
  saveRoomStates,
  deleteRoom
};

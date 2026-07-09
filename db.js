// SQLite persistence + ownership layer - Clients / Events / Rooms
//
// Runtime room state still lives in server.js's in-memory Map, exactly as before.
// This module owns storage AND the ownership/token lookups that gate access to it -
// it is not the timing engine.
//
// The in-memory Map (and Socket.IO's own "room" broadcast groups) are keyed by the
// room's numeric database id, never by the operator-chosen slug. Slugs are only
// unique within one client's rooms, not globally, so they are never safe to use as
// a cross-client lookup key on their own.

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

// ============================================
// Tokens / API keys
// ============================================

function generateToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function generateApiKey() {
  return 'key_' + crypto.randomBytes(32).toString('base64url');
}

function hashApiKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
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

// ============================================
// Clients
// ============================================

// Every client has exactly one "default" event for now (Phase 2 scope - no Event
// CRUD yet). Always the first event row created for that client.
function getOrCreateDefaultEvent(clientId) {
  let event = db.prepare('SELECT * FROM events WHERE client_id = ? ORDER BY id ASC LIMIT 1').get(clientId);
  if (!event) {
    const client = db.prepare('SELECT name FROM clients WHERE id = ?').get(clientId);
    const now = Date.now();
    const info = db.prepare(
      'INSERT INTO events (client_id, name, created_at) VALUES (?, ?, ?)'
    ).run(clientId, `${client ? client.name : 'Default'} Rooms`, now);
    event = { id: info.lastInsertRowid };
  }
  return event.id;
}

function createClient(name) {
  const now = Date.now();
  const rawKey = generateApiKey();
  const info = db.prepare(
    'INSERT INTO clients (name, api_key_hash, status, created_at) VALUES (?, ?, ?, ?)'
  ).run(name, hashApiKey(rawKey), 'active', now);
  const clientId = info.lastInsertRowid;
  const eventId = getOrCreateDefaultEvent(clientId);
  return { id: clientId, name, apiKey: rawKey, eventId };
}

// Generates a brand new key for an existing client, invalidating the old one.
// Returns null if no client with that name exists.
function rotateClientApiKey(name) {
  const client = db.prepare('SELECT * FROM clients WHERE name = ?').get(name);
  if (!client) return null;
  const rawKey = generateApiKey();
  db.prepare('UPDATE clients SET api_key_hash = ? WHERE id = ?').run(hashApiKey(rawKey), client.id);
  return { id: client.id, name: client.name, apiKey: rawKey };
}

function getClientByApiKey(rawKey) {
  if (!rawKey) return null;
  const client = db.prepare('SELECT * FROM clients WHERE api_key_hash = ?').get(hashApiKey(rawKey));
  if (!client || client.status !== 'active') return null;
  return client;
}

function getClientByName(name) {
  return db.prepare('SELECT * FROM clients WHERE name = ?').get(name) || null;
}

// Idempotent: safe to call on every boot. Also upgrades a Phase 1 Legacy client
// that predates API keys (api_key_hash was left NULL) by minting one now.
function getOrCreateLegacyClient() {
  let client = db.prepare('SELECT * FROM clients WHERE name = ?').get('Legacy');

  if (!client) {
    const now = Date.now();
    const rawKey = generateApiKey();
    const info = db.prepare(
      'INSERT INTO clients (name, api_key_hash, status, created_at) VALUES (?, ?, ?, ?)'
    ).run('Legacy', hashApiKey(rawKey), 'active', now);
    client = db.prepare('SELECT * FROM clients WHERE id = ?').get(info.lastInsertRowid);
    console.log(`📦 Created Legacy client (id=${client.id})`);
    console.log(`🔑 Legacy client API key (shown once - store it now):\n   ${rawKey}`);
    return client;
  }

  if (!client.api_key_hash) {
    const rawKey = generateApiKey();
    db.prepare('UPDATE clients SET api_key_hash = ? WHERE id = ?').run(hashApiKey(rawKey), client.id);
    console.log(`🔑 Legacy client had no API key (Phase 1 leftover) - generated one now (shown once - store it now):\n   ${rawKey}`);
  }

  return client;
}

const LEGACY_CLIENT = getOrCreateLegacyClient();
const LEGACY_EVENT_ID = getOrCreateDefaultEvent(LEGACY_CLIENT.id);

// ============================================
// Legacy rooms.json import (Phase 1, unchanged behaviour)
// ============================================

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

// ============================================
// Rooms
// ============================================

// Creates a room under the client's default event. Throws if the slug is already
// used by this client. state_json starts as an empty placeholder - the caller
// (server.js) is expected to immediately follow up with writeRoomState() using the
// real default timer state, before the room is reachable by any request.
function createRoom(clientId, slug) {
  const eventId = getOrCreateDefaultEvent(clientId);
  const now = Date.now();
  const controlToken = generateToken();
  const displayToken = generateToken();

  try {
    const info = db.prepare(`
      INSERT INTO rooms (event_id, slug, control_token, display_token, hidden, state_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, '{}', ?, ?)
    `).run(eventId, slug, controlToken, displayToken, now, now);

    return db.prepare('SELECT * FROM rooms WHERE id = ?').get(info.lastInsertRowid);
  } catch (err) {
    if (/UNIQUE/.test(err.message)) {
      throw new Error(`A room named "${slug}" already exists for this client`);
    }
    throw err;
  }
}

function getRoomById(id) {
  return db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) || null;
}

// Token can be either a control_token or a display_token - the matching column
// determines the caller's role. Returns null if the token doesn't match anything.
function getRoomByToken(token) {
  if (!token) return null;
  let room = db.prepare('SELECT * FROM rooms WHERE control_token = ?').get(token);
  if (room) return { room, role: 'control' };
  room = db.prepare('SELECT * FROM rooms WHERE display_token = ?').get(token);
  if (room) return { room, role: 'display' };
  return null;
}

// Ownership-scoped slug lookup, used by Companion/REST endpoints authenticated via
// a client API key. Returns null if the room doesn't exist OR belongs to a
// different client - callers must treat both cases identically (404).
function getRoomForClient(clientId, slug) {
  return db.prepare(`
    SELECT rooms.* FROM rooms
    JOIN events ON events.id = rooms.event_id
    WHERE events.client_id = ? AND rooms.slug = ?
  `).get(clientId, slug) || null;
}

function getRoomsForClient(clientId) {
  return db.prepare(`
    SELECT rooms.* FROM rooms
    JOIN events ON events.id = rooms.event_id
    WHERE events.client_id = ?
    ORDER BY rooms.created_at ASC
  `).all(clientId);
}

// Issues fresh tokens for a room, invalidating any previously distributed links.
function regenerateRoomTokens(clientId, slug) {
  const room = getRoomForClient(clientId, slug);
  if (!room) return null;
  const controlToken = generateToken();
  const displayToken = generateToken();
  db.prepare('UPDATE rooms SET control_token = ?, display_token = ?, updated_at = ? WHERE id = ?')
    .run(controlToken, displayToken, Date.now(), room.id);
  return { ...room, control_token: controlToken, display_token: displayToken };
}

// Immediate (non-debounced) single-room write - used right after createRoom() so
// the DB never holds the '{}' placeholder any longer than this one call.
function writeRoomState(id, state) {
  db.prepare('UPDATE rooms SET state_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(state), Date.now(), id);
}

// Load every room's state_json into a Map keyed by room id (as a string), matching
// the shape server.js has always used internally (Map<roomId, timerState>).
function loadAllRoomStates() {
  const rows = db.prepare('SELECT id, state_json FROM rooms').all();
  const result = new Map();
  for (const row of rows) {
    try {
      result.set(String(row.id), JSON.parse(row.state_json));
    } catch (err) {
      console.error(`⚠️  Skipping room id=${row.id} - corrupt state_json:`, err.message);
    }
  }
  return result;
}

// Updates every room currently in the in-memory Map by its id. Every entry is
// expected to already have a DB row (created via createRoom() or loaded via
// loadAllRoomStates()) - this never inserts.
function saveRoomStates(timerRooms) {
  const now = Date.now();
  const update = db.prepare('UPDATE rooms SET state_json = ?, updated_at = ? WHERE id = ?');

  const saveAll = db.transaction((entries) => {
    for (const [id, state] of entries) {
      update.run(JSON.stringify(state), now, id);
    }
  });

  saveAll(Array.from(timerRooms.entries()));
}

function deleteRoom(id) {
  db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
}

module.exports = {
  DATABASE_PATH,
  LEGACY_ROOMS_JSON_PATH,
  // clients
  createClient,
  rotateClientApiKey,
  getClientByApiKey,
  getClientByName,
  // rooms
  createRoom,
  getRoomById,
  getRoomByToken,
  getRoomForClient,
  getRoomsForClient,
  regenerateRoomTokens,
  writeRoomState,
  loadAllRoomStates,
  saveRoomStates,
  deleteRoom
};

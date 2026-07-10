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
const bcrypt = require('bcryptjs');

// Bcrypt cost factor - kept modest (not the common 12) because this is a
// real-time app: bcryptjs's "async" API chunks its work via setImmediate
// rather than using a worker thread, so a login attempt still competes for
// CPU with the timer engine's own tick processing, just interleaved rather
// than fully blocking. 10 is still secure and keeps that window short.
const BCRYPT_COST = 10;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, fixed (not sliding)

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

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES clients(id),
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

// Migration: CREATE TABLE IF NOT EXISTS above doesn't retroactively add columns to
// an already-existing clients table (e.g. on an already-deployed Railway volume).
// This runs on every boot and is a no-op once the column exists.
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`🔧 Migrated: added ${table}.${column}`);
  }
}
ensureColumn('clients', 'is_platform_admin', 'INTEGER NOT NULL DEFAULT 0');

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

function createClient(name, { isPlatformAdmin = false } = {}) {
  const now = Date.now();
  const rawKey = generateApiKey();
  const info = db.prepare(
    'INSERT INTO clients (name, api_key_hash, status, created_at, is_platform_admin) VALUES (?, ?, ?, ?, ?)'
  ).run(name, hashApiKey(rawKey), 'active', now, isPlatformAdmin ? 1 : 0);
  const clientId = info.lastInsertRowid;
  const eventId = getOrCreateDefaultEvent(clientId);
  return { id: clientId, name, apiKey: rawKey, eventId, isPlatformAdmin };
}

// BizShows-only. A dedicated function (rather than a flag on ordinary client
// creation) so granting platform-wide access is always a deliberate act.
function createPlatformAdmin(name) {
  return createClient(name, { isPlatformAdmin: true });
}

function listClients() {
  return db.prepare(`
    SELECT clients.id, clients.name, clients.status, clients.is_platform_admin, clients.created_at,
           COUNT(rooms.id) AS room_count
    FROM clients
    LEFT JOIN events ON events.client_id = clients.id
    LEFT JOIN rooms ON rooms.event_id = events.id
    GROUP BY clients.id
    ORDER BY clients.name
  `).all();
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

function getClientById(id) {
  return db.prepare('SELECT * FROM clients WHERE id = ?').get(id) || null;
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

// One-shot platform admin bootstrap, for environments where the database only
// exists on a remote volume (e.g. Railway) that scripts/create-platform-admin.js
// can't reach from a local machine. Inert unless BOOTSTRAP_PLATFORM_ADMIN is set;
// safe to leave the env var set permanently since it no-ops once the named client
// exists. Does not touch the Legacy client or any other client.
function bootstrapPlatformAdminIfRequested() {
  const name = process.env.BOOTSTRAP_PLATFORM_ADMIN;
  if (!name) return;

  const existing = getClientByName(name);
  if (existing) {
    console.log(`[BOOTSTRAP_PLATFORM_ADMIN] Client "${name}" already exists (id=${existing.id}) - skipping. Use scripts/rotate-client-key.js if you need a new key.`);
    return;
  }

  const admin = createPlatformAdmin(name);
  console.log(`\n🔑 [BOOTSTRAP_PLATFORM_ADMIN] Created platform admin "${admin.name}" (id=${admin.id}) - this key can see and control EVERY client's rooms.`);
  console.log(`   API key (shown once - store it now):\n   ${admin.apiKey}\n`);
}
bootstrapPlatformAdminIfRequested();

// ============================================
// Users & Sessions (Phase 6a) - human dashboard login, separate from the
// clients.api_key_hash machine-to-machine identity used by Companion/API
// integrations, which this section never touches.
//
// A user always belongs to exactly one client (client_id NOT NULL, including
// platform-admin users - see module comment below for why). Passwords use
// bcrypt (slow, salted - appropriate for low-entropy human-chosen secrets);
// this is deliberately NOT hashApiKey()'s fast SHA-256, which is only correct
// for the high-entropy random tokens used elsewhere (API keys, control/
// display tokens, session tokens below).
// ============================================

function generateTempPassword() {
  // High-entropy, not meant to be memorised - the user changes it on first
  // login (must_change_password). Reuses the same random source as API keys.
  return crypto.randomBytes(18).toString('base64url');
}

function createUser(email, password, clientId, { mustChangePassword = false } = {}) {
  const now = Date.now();
  const passwordHash = bcrypt.hashSync(password, BCRYPT_COST);
  const info = db.prepare(`
    INSERT INTO users (client_id, email, password_hash, must_change_password, status, created_at)
    VALUES (?, ?, ?, ?, 'active', ?)
  `).run(clientId, email.toLowerCase(), passwordHash, mustChangePassword ? 1 : 0, now);
  return { id: info.lastInsertRowid, email: email.toLowerCase(), clientId };
}

function getUserByEmail(email) {
  if (!email) return null;
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase()) || null;
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

function listUsers() {
  // Never selects password_hash - this is for safe listing (CLI/support use),
  // not authentication.
  return db.prepare(`
    SELECT users.id, users.email, users.must_change_password, users.status, users.created_at,
           clients.id AS client_id, clients.name AS client_name, clients.is_platform_admin
    FROM users
    JOIN clients ON clients.id = users.client_id
    ORDER BY clients.name, users.email
  `).all();
}

// Async (not hashSync) - bcryptjs chunks the async path via setImmediate so a
// login attempt doesn't fully block the event loop while other rooms' timer
// ticks are trying to run. Returns the user row on success, null on any
// failure (unknown email, wrong password, inactive user) - callers must treat
// all three identically so a login failure never reveals which was wrong.
async function verifyUserPassword(email, password) {
  const user = getUserByEmail(email);
  if (!user || user.status !== 'active') return null;
  const ok = await bcrypt.compare(password, user.password_hash);
  return ok ? user : null;
}

// Used by the forced first-login change flow. Verifies currentPassword,
// replaces password_hash, clears must_change_password, and invalidates every
// OTHER session for this user (keeps the caller's own current session alive -
// server.js issues a fresh session token immediately after calling this).
async function changePassword(userId, currentPassword, newPassword, currentRawSessionToken) {
  const user = getUserById(userId);
  if (!user) return { ok: false, error: 'User not found' };
  const ok = await bcrypt.compare(currentPassword, user.password_hash);
  if (!ok) return { ok: false, error: 'Current password is incorrect' };

  const newHash = bcrypt.hashSync(newPassword, BCRYPT_COST);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(newHash, userId);

  // Hashing stays encapsulated here, same as every other token lookup in this
  // module - callers pass the raw token, never a pre-hashed value.
  if (currentRawSessionToken) {
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?')
      .run(userId, hashApiKey(currentRawSessionToken));
  } else {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }
  return { ok: true };
}

// Admin/CLI password reset - generates a new temporary password, re-flags
// must_change_password, and invalidates ALL existing sessions for that user
// (including whatever session they were using, unlike changePassword() above -
// a reset means "I no longer trust this account's current state").
function resetUserPassword(email) {
  const user = getUserByEmail(email);
  if (!user) return null;
  const tempPassword = generateTempPassword();
  const passwordHash = bcrypt.hashSync(tempPassword, BCRYPT_COST);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(passwordHash, user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  return { id: user.id, email: user.email, tempPassword };
}

// Same trim+lowercase normalisation login/createUser already apply, plus a
// basic format sanity check - not full RFC5322 validation, just enough to
// catch an obvious typo before it's stored.
function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmailFormat(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Renames a user's login email in place - same id, password_hash,
// must_change_password, and client_id (so platform-admin status, which is
// derived transitively through the linked client, is untouched too) - only
// the email column changes. Invalidates all of that user's existing sessions,
// since a session cookie was issued to "whoever could log in as the old
// email" and the account's identity has now changed. Never touches
// clients.api_key_hash or any room token.
function changeUserEmail(currentEmail, newEmail) {
  const user = getUserByEmail(currentEmail);
  if (!user) return { ok: false, error: `No user found with email "${currentEmail}"` };

  const normalized = normalizeEmail(newEmail);
  if (!isValidEmailFormat(normalized)) {
    return { ok: false, error: `"${newEmail}" doesn't look like a valid email address` };
  }

  const existing = getUserByEmail(normalized);
  if (existing && existing.id === user.id) {
    return { ok: false, error: `"${normalized}" is already this user's current email` };
  }
  if (existing) {
    return { ok: false, error: `Email "${normalized}" is already assigned to another user` };
  }

  db.prepare('UPDATE users SET email = ? WHERE id = ?').run(normalized, user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);

  return { ok: true, id: user.id, oldEmail: user.email, newEmail: normalized };
}

// One-shot production-safe email correction, same reasoning as every other
// BOOTSTRAP_* var: the database only lives on Railway's volume, unreachable
// from a local script run, so a boot-time env-var trigger is the proven safe
// path rather than assuming a Railway CLI/SSH command has volume access.
// Idempotent: if a user already has the target email, assumes the rename
// already happened on an earlier boot and skips rather than erroring or
// attempting it again.
function renameUserEmailIfRequested() {
  const from = process.env.RENAME_USER_EMAIL_FROM;
  const to = process.env.RENAME_USER_EMAIL_TO;
  if (!from || !to) return;

  const alreadyAtTarget = getUserByEmail(to);
  if (alreadyAtTarget) {
    console.log(`[RENAME_USER_EMAIL_FROM/TO] A user already has email "${to}" - assuming this already happened, skipping.`);
    return;
  }

  const result = changeUserEmail(from, to);
  if (!result.ok) {
    console.error(`❌ [RENAME_USER_EMAIL_FROM/TO] ${result.error}`);
    return;
  }
  console.log(`✅ [RENAME_USER_EMAIL_FROM/TO] Renamed user id=${result.id} from "${result.oldEmail}" to "${result.newEmail}" - they must log in again with the new email.`);
}
renameUserEmailIfRequested();

// ---- Sessions ----

// Opportunistic cleanup, run on every new session creation - no separate
// cleanup job needed at this scale.
function deleteExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

// Returns the RAW token once - only ever available here and in the Set-Cookie
// header. The database only ever stores its hash (SHA-256, same principle as
// hashApiKey() - session tokens are high-entropy random values, not
// low-entropy human secrets, so a fast hash is correct here, unlike passwords).
function createSession(userId) {
  deleteExpiredSessions();
  const now = Date.now();
  const rawToken = generateToken();
  const expiresAt = now + SESSION_TTL_MS;
  db.prepare(`
    INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(hashApiKey(rawToken), userId, now, expiresAt);
  return { rawToken, expiresAt };
}

// Hashes the presented cookie value and looks up by hash - the raw token
// itself is never stored or queried directly.
function getSessionUser(rawToken) {
  if (!rawToken) return null;
  const row = db.prepare(`
    SELECT users.* FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).get(hashApiKey(rawToken), Date.now());
  return row || null;
}

function deleteSession(rawToken) {
  if (!rawToken) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashApiKey(rawToken));
}

// One-shot bootstrap for the first Platform Administrator human login, for the
// same reason the Phase 3 platform-admin client bootstrap exists: the
// production database only lives on Railway's volume, unreachable from a
// local script run. Inert unless BOOTSTRAP_ADMIN_USER_EMAIL is set. Requires
// a platform-admin client to already exist (BOOTSTRAP_PLATFORM_ADMIN, above) -
// links the new user to it rather than guessing. Creates at most once: never
// prints or regenerates a password for an already-existing user on later
// boots, and never touches the Legacy client or the Platform Administrator
// API key.
function bootstrapAdminUserIfRequested() {
  const email = process.env.BOOTSTRAP_ADMIN_USER_EMAIL;
  if (!email) return;

  const existing = getUserByEmail(email);
  if (existing) {
    console.log(`[BOOTSTRAP_ADMIN_USER_EMAIL] User "${email}" already exists (id=${existing.id}) - skipped. Use scripts/reset-user-password.js if you need new credentials.`);
    return;
  }

  const adminClient = db.prepare('SELECT * FROM clients WHERE is_platform_admin = 1 ORDER BY id ASC LIMIT 1').get();
  if (!adminClient) {
    console.error(`❌ [BOOTSTRAP_ADMIN_USER_EMAIL] No platform-admin client exists yet - set BOOTSTRAP_PLATFORM_ADMIN first (Phase 3), redeploy once, then set BOOTSTRAP_ADMIN_USER_EMAIL.`);
    return;
  }

  const tempPassword = generateTempPassword();
  const user = createUser(email, tempPassword, adminClient.id, { mustChangePassword: true });
  console.log(`\n🔑 [BOOTSTRAP_ADMIN_USER_EMAIL] Created login "${email}" (user id=${user.id}, linked to platform-admin client "${adminClient.name}").`);
  console.log(`   Temporary password (shown once - you'll be asked to change it on first login):\n   ${tempPassword}\n`);
}
bootstrapAdminUserIfRequested();

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

// Platform-admin-only: every room across every client, with the owning client's
// id/name attached. Slugs are NOT unique across this result set (only within one
// client), so callers must key off room id, never slug, once mixing clients.
function getAllRoomsWithClientNames() {
  return db.prepare(`
    SELECT rooms.*, clients.id AS client_id, clients.name AS client_name
    FROM rooms
    JOIN events ON events.id = rooms.event_id
    JOIN clients ON clients.id = events.client_id
    ORDER BY clients.name, rooms.created_at ASC
  `).all();
}

// Platform-admin-only: look up a room by its globally-unique id, with owning
// client id/name attached - no ownership check, unlike getRoomForClient().
function getRoomWithClientById(id) {
  return db.prepare(`
    SELECT rooms.*, clients.id AS client_id, clients.name AS client_name
    FROM rooms
    JOIN events ON events.id = rooms.event_id
    JOIN clients ON clients.id = events.client_id
    WHERE rooms.id = ?
  `).get(id) || null;
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
  createPlatformAdmin,
  rotateClientApiKey,
  getClientByApiKey,
  getClientByName,
  getClientById,
  listClients,
  // users
  generateTempPassword,
  createUser,
  getUserByEmail,
  getUserById,
  listUsers,
  verifyUserPassword,
  changePassword,
  resetUserPassword,
  changeUserEmail,
  // sessions
  createSession,
  getSessionUser,
  deleteSession,
  // rooms
  createRoom,
  getRoomById,
  getRoomByToken,
  getRoomForClient,
  getRoomsForClient,
  getAllRoomsWithClientNames,
  getRoomWithClientById,
  regenerateRoomTokens,
  writeRoomState,
  loadAllRoomStates,
  saveRoomStates,
  deleteRoom
};

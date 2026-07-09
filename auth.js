// Ownership checks for HTTP and Socket.IO, backed by db.js.
//
// Nothing here trusts a client-declared identity (room name, "type" query param,
// etc.) - every check resolves identity from a server-issued secret (API key or
// room token) looked up against the database.

const db = require('./db');

// Express middleware - requires `Authorization: Bearer <apiKey>`, attaches req.client.
function requireClientAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const rawKey = match ? match[1].trim() : null;
  const client = db.getClientByApiKey(rawKey);

  if (!client) {
    return res.status(401).json({ ok: false, error: 'Missing or invalid API key' });
  }

  req.client = client;
  next();
}

// Express middleware, chained after requireClientAuth - resolves :roomId (a slug)
// to a room owned by req.client. 404s if the room doesn't exist OR belongs to a
// different client; both cases must look identical to the caller.
function resolveOwnedRoom(req, res, next) {
  const room = db.getRoomForClient(req.client.id, req.params.roomId);

  if (!room) {
    return res.status(404).json({ ok: false, error: 'Room not found' });
  }

  req.room = room;
  req.roomId = String(room.id);
  next();
}

// Socket.IO handshake resolver - given a token (either a control_token or a
// display_token), returns { room, role, roomId } or null. `role` is derived from
// which column matched, never from anything the client declared.
function resolveSocketAccess(token) {
  const access = db.getRoomByToken(token);
  if (!access) return null;
  return { room: access.room, role: access.role, roomId: String(access.room.id) };
}

// Express middleware, chained after requireClientAuth - 403s unless req.client is
// flagged as a platform admin. Platform admin is BizShows-only, provisioned via
// scripts/create-platform-admin.js, never granted implicitly.
function requirePlatformAdmin(req, res, next) {
  if (!req.client.is_platform_admin) {
    return res.status(403).json({ ok: false, error: 'Platform admin access required' });
  }
  next();
}

// Express middleware, chained after requireClientAuth + requirePlatformAdmin -
// resolves :id (the room's numeric database id) with NO ownership restriction,
// since a platform admin can act on any client's room. Unlike resolveOwnedRoom,
// slugs are never used here - they aren't unique once multiple clients are in play.
function resolveRoomById(req, res, next) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ ok: false, error: 'Invalid room id' });
  }

  const room = db.getRoomWithClientById(id);
  if (!room) {
    return res.status(404).json({ ok: false, error: 'Room not found' });
  }

  req.room = room;
  req.roomId = String(room.id);
  next();
}

module.exports = {
  requireClientAuth,
  resolveOwnedRoom,
  resolveSocketAccess,
  requirePlatformAdmin,
  resolveRoomById
};

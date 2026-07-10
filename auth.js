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

// ============================================
// Sessions (Phase 6a) - human dashboard login, cookie-based.
//
// Deliberately hand-rolled rather than adding cookie-parser: only one cookie
// is ever read or set, so a tiny helper is simpler than evaluating a new
// dependency's own attack surface for a single-cookie use case.
// ============================================

const SESSION_COOKIE = 'session';

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

// req.secure reflects the real scheme (respects `trust proxy`, already set in
// server.js), so this adapts automatically to Railway's HTTPS in production
// and plain HTTP in local dev - no NODE_ENV guess needed either way.
function setSessionCookie(req, res, rawToken, expiresAt) {
  const maxAgeSec = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(rawToken)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`
  ];
  if (req.secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
}

// Bare session check - no must-change-password gate, no Bearer fallback. Used
// only by the endpoints a not-yet-fully-set-up account must still be able to
// reach: /api/auth/logout and /api/auth/change-password.
function requireSession(req, res, next) {
  const rawToken = parseCookies(req)[SESSION_COOKIE];
  const user = db.getSessionUser(rawToken);
  if (!user) {
    return res.status(401).json({ ok: false, error: 'Not logged in' });
  }
  req.user = user;
  req.sessionToken = rawToken;
  next();
}

// Lightweight CSRF mitigation for state-changing, session-authenticated
// requests: a cookie is sent automatically by the browser, unlike a Bearer
// header, so cookie-authenticated mutations need this extra check - Bearer-
// authenticated requests don't (an attacker's page can't attach an arbitrary
// Authorization header via a cross-site form/link). If neither Origin nor
// Referer is present, the request isn't a browser cross-site attempt
// (Companion, curl, same-origin navigations that omit both) - allow it.
function isSameOrigin(req) {
  const candidate = req.headers.origin || req.headers.referer;
  if (!candidate) return true;
  try {
    return new URL(candidate).host === req.headers.host;
  } catch {
    return false;
  }
}

// The main dashboard/room-management auth gate: accepts EITHER the existing
// Bearer API key (unchanged behaviour, tried first) OR a valid session
// cookie (new). This is an emergency/compatibility fallback for Bearer, not a
// weakening of it - ownership is still always resolved from req.client
// exactly as before, regardless of which method authenticated the request.
function requireDashboardAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match) {
    const client = db.getClientByApiKey(match[1].trim());
    if (client) {
      req.client = client;
      req.authMethod = 'apiKey';
      return next();
    }
  }

  const rawToken = parseCookies(req)[SESSION_COOKIE];
  const user = db.getSessionUser(rawToken);
  if (!user) {
    return res.status(401).json({ ok: false, error: 'Not authenticated' });
  }

  if (['POST', 'DELETE', 'PUT', 'PATCH'].includes(req.method) && !isSameOrigin(req)) {
    return res.status(403).json({ ok: false, error: 'Cross-origin request rejected' });
  }

  if (user.must_change_password) {
    return res.status(403).json({ ok: false, error: 'Password change required', mustChangePassword: true });
  }

  // Client ownership resolved server-side from users.client_id - never from
  // anything the browser sent. Structurally identical to the Bearer-key path
  // above, so every downstream route/middleware (resolveOwnedRoom,
  // requirePlatformAdmin, resolveRoomById) works unchanged either way.
  const client = db.getClientById(user.client_id);
  if (!client) {
    return res.status(401).json({ ok: false, error: 'Not authenticated' });
  }

  req.client = client;
  req.user = user;
  req.sessionToken = rawToken;
  req.authMethod = 'session';
  next();
}

module.exports = {
  requireClientAuth,
  resolveOwnedRoom,
  resolveSocketAccess,
  requirePlatformAdmin,
  resolveRoomById,
  // sessions
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  requireSession,
  requireDashboardAuth
};

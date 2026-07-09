# Multi-Tenant Product Status

Tracks progress converting Presentation Timer from a single-operator web app into a
licensable multi-tenant product. See project memory / conversation history for the
full design brief this work follows.

## Completed phases

### Phase 1 — Data model & persistence (SQLite)
- Replaced the flat `rooms.json` file with SQLite (`better-sqlite3`), via `db.js`.
- Schema: `clients` → `events` → `rooms` (one default event per client for now,
  no Event CRUD yet), plus a `meta` key/value table for one-off migration flags.
- `DATABASE_PATH` env var selects the DB file (Railway: `/data/presentation-timer.sqlite`
  on a mounted volume; local dev: `./data/presentation-timer.sqlite`, gitignored).
- `LEGACY_ROOMS_JSON_PATH` env var drove a one-time import of the old flat-file
  rooms into a synthetic "Legacy" client/event. Runs at most once, guarded by a
  meta flag; a missing file just logs a warning and continues - existing room data
  did not need to be preserved.
- Timer engine (drift correction, rundown, messaging) untouched; only the
  persistence backend changed. Same debounced (500ms) save as before.
- Railway build required `engines.node: "20.x"` (package.json) and `nixpacks.toml`
  (`nodejs_20`, `python3`, `gcc`, `gnumake`) for the native `better-sqlite3` addon
  to build under Nixpacks.

### Phase 2 — Ownership & token-based authentication
- Every room has a `control_token` and `display_token` (opaque, unguessable,
  generated at creation). Browser access is via `/control?token=...` and
  `/display?token=...` - the old `?room=<name>` links no longer work (deliberate
  cutover, approved; no legacy-link compatibility was required).
- Every client has an `api_key` (shown once at creation/rotation, stored only as
  a SHA-256 hash). Sent as `Authorization: Bearer <key>` on all REST/dashboard/
  Companion requests.
- Socket.IO role (`control` vs `display`) is derived server-side from which
  token matched the connection - never trusted from a client-declared param.
  Non-control sockets are rejected on every mutation event.
- In-memory timer-state Map is keyed by the room's numeric database id, not its
  slug - slugs are only unique per-client, not globally, so two clients can
  legitimately reuse the same room name with zero bleed (verified directly).
- All REST endpoints (room CRUD, Companion-style start/pause/rundown/message
  actions) are authenticated and ownership-scoped.
- Companion module updated to v1.2.0: sends the client API key as a Bearer
  header; a rejected key surfaces as a distinct `AuthenticationFailure` status.
- CLI: `scripts/create-client.js`, `scripts/rotate-client-key.js`,
  `scripts/list-room-links.js` (list/regenerate a client's room links).

### Phase 3 — RBAC roles & client-scoped Master Dashboard
- `clients.is_platform_admin` flag (migrated onto the existing table via
  `ALTER TABLE`, safe on an already-populated DB - verified against a live
  test database with existing clients).
- Platform Admin (BizShows-only) sees and can act on every client's rooms;
  a normal client key is completely unaffected - sees only its own rooms,
  exactly as in Phase 2 (regression-tested directly).
- `GET /api/whoami` tells the dashboard which view to render.
- `/api/admin/rooms/:id/*` routes (start/pause/resume/reset/delete/
  regenerate-tokens) - addressed by numeric id, not slug, since slugs collide
  across clients by design once you're looking platform-wide.
- Dashboard: client-name badge per room in platform-admin view; platform-wide
  "Start All" does not exist (client-scoped Start All is unaffected); "Stop
  All"/Delete/Regenerate get an extra confirmation naming the affected client
  when acting cross-client.
- CLI: `scripts/create-platform-admin.js`, `scripts/list-clients.js`. Client
  management is deliberately CLI-only for now - no web UI for creating/listing
  clients (see "Known future admin/client UI improvements" below).
- `BOOTSTRAP_PLATFORM_ADMIN` env var: since the production DB only exists on
  Railway's volume (unreachable from a local script run), setting this var and
  redeploying creates the named platform admin and prints its key once to the
  boot log - reuses the same pattern already proven for Legacy-client key
  recovery. Inert unless set; safe to leave set (no-ops once the client exists).

## Current login / API key behaviour

There is no user-account system - no passwords, no sessions, no cookies.
Two credential types, both opaque bearer secrets:

1. **Client API key** - entered once into the dashboard via a `prompt()`,
   stored in the browser's `localStorage`, sent as a Bearer header on every
   dashboard request. Same key is used for Companion's config.
2. **Room control/display tokens** - embedded directly in the room's URL; the
   token itself is the credential, no separate login step. Control token =
   full control; display token = strictly read-only (verified: a display
   token cannot mutate state even if a client attempts it directly).

No expiry, no rotation schedule, no MFA, no self-service signup - every
credential is provisioned manually via a CLI script run by BizShows. This is
intentionally lightweight per the original brief, and is adequate for
Companion and internal use, but is **not** the intended long-term experience
for a client's own staff logging into their dashboard daily - see the new
future phase below.

## Railway volume / database assumptions

- The SQLite file must live on a Railway-mounted persistent volume
  (`DATABASE_PATH=/data/presentation-timer.sqlite`), not the ephemeral app
  filesystem - confirmed working via Phase 1 deploy + redeploy test.
- Local dev falls back to `./data/presentation-timer.sqlite` (gitignored).
- WAL journal mode is enabled. This is safe for the current single
  application-process model; it is **not** designed for multiple app
  instances writing to the same file concurrently - horizontal scaling of
  the web process would need further work.
- The production database is **not reachable from a local machine**. Any
  one-off admin action against production must run inside the Railway
  environment itself. The established pattern for this is an env-var-gated
  bootstrap checked at boot, logging its result once to Railway's deploy
  logs - not a Railway CLI/SSH command (deliberately avoided since volume
  access from `railway run` was not confirmed).
- `nixpacks.toml` pins `nodejs_20` + `python3`/`gcc`/`gnumake` because
  supplying a custom `[phases.setup]` replaces (not merges with) Nixpacks'
  default package set - needed for better-sqlite3's native build.
- **No backup/restore process exists yet for the volume.** Not addressed by
  any phase so far - worth flagging as a real gap, not yet planned.

## Known future admin/client UI improvements (captured, not started)

Approved as a future phase, not to be implemented until explicitly requested:

- Proper client login: email/password or magic link, replacing API-key-in-
  a-`prompt()`.
- Persistent session/cookie-based login, replacing the raw API key sitting
  in `localStorage`.
- A client details page.
- A client list view for Platform Admin (currently CLI-only via
  `list-clients.js`).
- Client profile/status/API key management from the UI (currently CLI-only:
  create/rotate via scripts).
- Events and rooms shown under each client in the UI (currently: one default
  event per client, not surfaced anywhere in the UI).

## Remaining planned phases

- **Phase 4 - Room controller exclusivity / collaboration model.** Replace
  "anyone holding the control token can issue commands with no coordination"
  with something that supports legitimate multi-operator collaboration
  without silent conflicting commands. Proposal pending approval.
- **Phase 5 - Active Rooms visibility.** Fold fully into the authenticated
  dashboard (largely already true post-Phase 2/3); add an optional per-room
  "hidden from Active Rooms" operational flag (not a security control).
- **Phase 6 - Client login & admin UX overhaul.** The future phase captured
  above: real authentication, sessions, and client/event/room management UI.
  Explicitly deferred - not started, not scheduled.
